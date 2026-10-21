# Windows counterpart of provision-runner-tooling.sh. Installs a pinned
# toolchain once per host under host-tools\ and gives each runner only shims
# and its own runtime state. -WriteEnv refreshes the runner's .env, .path, and
# home .npmrc without reinstalling anything.
param(
  [string]$Root = $PSScriptRoot,
  [switch]$DryRun,
  [switch]$PrintEnv,
  [switch]$PrintManifest,
  [switch]$WriteEnv
)
$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
. (Join-Path $ScriptDir 'platform.ps1')

$NodeVersion = '24.19.0'
$PnpmVersion = '11.20.0'
$WranglerVersion = '4.69.0'
$PulumiVersion = '3.143.0'
$AwsVersion = '2.36.11'

$Root = [IO.Path]::GetFullPath($Root)
$ToolsDir = Join-Path $Root 'tools'
$HostToolsDir = if ($env:RUNNER_HOST_TOOLS_DIR) { $env:RUNNER_HOST_TOOLS_DIR } else { Join-Path $ScriptDir 'host-tools' }
$LocalBinDir = Join-Path $ToolsDir 'bin'
$PnpmHome = Join-Path $ToolsDir 'pnpm-global'
$PnpmBinDir = Join-Path $PnpmHome 'bin'
$CorepackHome = Join-Path $HostToolsDir 'corepack'
$PnpmToolsDir = Join-Path $HostToolsDir 'pnpm-tools'
$PnpmToolsBinDir = Join-Path $PnpmToolsDir 'bin'
$PnpmStoreDir = if ($env:RUNNER_PNPM_STORE_DIR) { $env:RUNNER_PNPM_STORE_DIR } else { Join-Path $ScriptDir '.pnpm-store' }
$NpmCacheDir = Join-Path $HostToolsDir 'npm-cache'
$PulumiHome = Join-Path $HostToolsDir 'pulumi-home'
$RunnerHome = Join-Path $Root 'home'
$RunnerTmp = Join-Path $Root 'tmp'
$RunnerTemp = Join-Path $Root '_work\_temp'
$RunnerToolCache = if ($env:RUNNER_SHARED_TOOL_CACHE) { $env:RUNNER_SHARED_TOOL_CACHE } else { Join-Path $HostToolsDir 'tool-cache' }
# actions/setup-node uses this layout on Windows: node.exe sits in the version root.
$NodeInstallDir = Join-Path $RunnerToolCache "node\$NodeVersion\$RunnerNodeArch"
$NodeCompleteMarker = Join-Path $RunnerToolCache "node\$NodeVersion\$RunnerNodeArch.complete"
$PulumiInstallDir = Join-Path $HostToolsDir "pulumi\$PulumiVersion"
$AwsInstallDir = Join-Path $HostToolsDir "aws-cli\$AwsVersion"
$AwsBinPath = Join-Path $AwsInstallDir 'Amazon\AWSCLIV2\aws.exe'
$AwsPackageUrl = if ($env:RUNNER_AWS_PACKAGE_URL) { $env:RUNNER_AWS_PACKAGE_URL } else { "https://awscli.amazonaws.com/AWSCLIV2-$AwsVersion.msi" }
$ManifestPath = Join-Path $ToolsDir 'runner-tooling.env'
# Installers below prepend tool directories; the runner PATH starts from this.
$AmbientPath = $env:PATH

function Get-ManifestContents {
  @(
    "RUNNER_TOOL_NODE_VERSION=$NodeVersion"
    "RUNNER_TOOL_PNPM_VERSION=$PnpmVersion"
    "RUNNER_TOOL_WRANGLER_VERSION=$WranglerVersion"
    "RUNNER_TOOL_PULUMI_VERSION=$PulumiVersion"
    "RUNNER_TOOL_AWS_VERSION=$AwsVersion"
  ) -join "`n"
}

# pnpm 10 uses PNPM_HOME itself for global shims; pnpm 11+ uses PNPM_HOME\bin.
# Match pnpm/setup by exposing both locations ahead of the ambient PATH.
function Get-RunnerPath {
  $entries = New-Object Collections.Generic.List[string]
  foreach ($entry in @($LocalBinDir, $PnpmHome, $PnpmBinDir, $NodeInstallDir) + ($AmbientPath -split ';')) {
    if (-not $entry) { continue }
    if ($env:USERPROFILE -and ($entry -ieq (Join-Path $env:USERPROFILE 'AppData\Local\pnpm') -or $entry -ieq (Join-Path $env:USERPROFILE 'setup-pnpm'))) { continue }
    if (-not ($entries | Where-Object { $_ -ieq $entry })) { $entries.Add($entry) }
  }
  $entries -join ';'
}

# Runner.Listener reads .env as plain KEY=value lines; there is no shell quoting.
function Get-EnvFileLines {
  $managedTemp = Join-Path $RunnerTmp 'managed-job'
  $lines = @(
    "HOME=$RunnerHome"
    "USERPROFILE=$RunnerHome"
    "XDG_CONFIG_HOME=$(Join-Path $RunnerHome '.config')"
    "TMPDIR=$managedTemp"
    "TMP=$managedTemp"
    "TEMP=$managedTemp"
    "RUNNER_TEMP=$RunnerTemp"
    "RUNNER_TOOL_CACHE=$RunnerToolCache"
    "PNPM_HOME=$PnpmHome"
    "COREPACK_HOME=$CorepackHome"
    "PULUMI_HOME=$PulumiHome"
  )
  if (Test-Path -LiteralPath (Join-Path $Root 'job-hooks\runner-job-started.ps1')) { $lines += Get-JobHookEnvLines }
  $lines
}

# Preserve custom hooks across repeated provisioning without chaining the
# managed wrappers to themselves.
function Get-JobHookEnvLines {
  $existing = @{}
  $envPath = Join-Path $Root '.env'
  if (Test-Path -LiteralPath $envPath) {
    foreach ($line in (Read-KitText $envPath) -split "`r?`n") {
      if ($line -match '^(ACTIONS_RUNNER_HOOK_JOB_(STARTED|COMPLETED)|RUNNER_PREVIOUS_JOB_(STARTED|COMPLETED)_HOOK)=(.*)$') {
        $existing[$Matches[1]] = $Matches[4]
      }
    }
  }
  foreach ($phase in 'STARTED', 'COMPLETED') {
    $managedHook = Join-Path $Root "job-hooks\runner-job-$($phase.ToLowerInvariant()).ps1"
    $previousHook = $existing["ACTIONS_RUNNER_HOOK_JOB_$phase"]
    if ($previousHook -ieq $managedHook) { $previousHook = $existing["RUNNER_PREVIOUS_JOB_${phase}_HOOK"] }
    "RUNNER_PREVIOUS_JOB_${phase}_HOOK=$previousHook"
    "ACTIONS_RUNNER_HOOK_JOB_$phase=$managedHook"
  }
}

# Point package managers at the shared content-addressable stores; without
# this, every runner home accumulates a private copy.
function Write-Npmrc {
  $npmrcPath = Join-Path $RunnerHome '.npmrc'
  $lines = @()
  if (Test-Path -LiteralPath $npmrcPath) {
    # @() keeps a single preserved line an array, so += appends rather than concatenates.
    $lines = @((Read-KitText $npmrcPath) -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '^(store-dir|cache|global-bin-dir|global-dir|prefix)=' })
  }
  $lines += "store-dir=$PnpmStoreDir", "cache=$NpmCacheDir"
  Write-KitText $npmrcPath (($lines -join "`n") + "`n")
}

# PNPM_HOME owns the global layout; drop explicit path settings that would
# override it while preserving unrelated global settings.
function Set-PnpmGlobalConfig {
  $configPath = Join-Path $RunnerHome '.config\pnpm\config.yaml'
  if (-not (Test-Path -LiteralPath $configPath)) { return }
  $lines = @((Read-KitText $configPath) -split "`r?`n" | Where-Object { $_ -notmatch '^(global-bin-dir|global-dir|globalBinDir|globalDir|prefix):(\s|$)' })
  Write-KitText $configPath ($lines -join "`n")
}

# A .cmd shim keeps the real launcher path, so pnpm-generated launchers and
# Pulumi plugins resolve next to their actual install.
function Write-CmdShim([string]$Target, [string]$ShimPath) {
  if ($DryRun) { return }
  if (-not (Test-Path -LiteralPath $Target)) { throw "runner tool launcher is missing: $Target" }
  New-Item -ItemType Directory -Force -Path (Split-Path $ShimPath) | Out-Null
  Write-KitText $ShimPath "@`"$Target`" %*`r`n"
}

function Write-EnvFiles {
  foreach ($directory in $RunnerHome, $RunnerTmp, (Join-Path $RunnerTmp 'managed-job'), $RunnerTemp, $LocalBinDir, $PnpmBinDir) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }
  Write-CmdShim (Join-Path $PnpmToolsBinDir 'wrangler.cmd') (Join-Path $LocalBinDir 'wrangler.cmd')
  Write-KitText (Join-Path $Root '.env') (((Get-EnvFileLines) -join "`n") + "`n")
  Write-KitText (Join-Path $Root '.path') ((Get-RunnerPath) + "`n")
  Write-Npmrc
  Set-PnpmGlobalConfig
}

function Invoke-Checked([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($File)) failed with exit code $LASTEXITCODE" }
}

function New-TempDirectory([string]$Parent) {
  New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $Parent ".install-$([Guid]::NewGuid().ToString('N'))")
}

function Install-Node {
  if ((Test-Path -LiteralPath (Join-Path $NodeInstallDir 'node.exe')) -and (Test-Path -LiteralPath $NodeCompleteMarker)) { return }
  if ($DryRun) { return }
  $temp = New-TempDirectory (Join-Path $RunnerToolCache 'node')
  try {
    $archive = "node-v$NodeVersion-$RunnerNodePlatform"
    Invoke-KitDownload "https://nodejs.org/dist/v$NodeVersion/$archive.zip" (Join-Path $temp "$archive.zip")
    Expand-KitZip (Join-Path $temp "$archive.zip") $temp
    New-Item -ItemType Directory -Force -Path (Split-Path $NodeInstallDir) | Out-Null
    if (Test-Path -LiteralPath $NodeInstallDir) { Remove-Item -LiteralPath $NodeInstallDir -Recurse -Force }
    Move-Item -LiteralPath (Join-Path $temp $archive) -Destination $NodeInstallDir
    Write-KitText $NodeCompleteMarker ''
  } finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
}

function Get-PnpmVersion {
  $pnpm = Join-Path $PnpmBinDir 'pnpm.cmd'
  if (-not (Test-Path -LiteralPath $pnpm)) { return '' }
  try { (& $pnpm --version 2>$null | Select-Object -First 1) } catch { '' }
}

function Install-Pnpm {
  $env:COREPACK_HOME = $CorepackHome
  $env:PATH = "$LocalBinDir;$PnpmBinDir;$NodeInstallDir;$env:PATH"
  if ((Get-PnpmVersion) -eq $PnpmVersion) { return }
  if ($DryRun) { return }
  New-Item -ItemType Directory -Force -Path $PnpmBinDir, $CorepackHome | Out-Null
  $corepack = Join-Path $NodeInstallDir 'corepack.cmd'
  Invoke-Checked $corepack @('install', '--global', "pnpm@$PnpmVersion")
  Invoke-Checked $corepack @('enable', '--install-directory', $PnpmBinDir, 'pnpm')
  $installed = Get-PnpmVersion
  if ($installed -ne $PnpmVersion) { throw "pnpm $PnpmVersion verification failed: $installed" }
}

function Get-WranglerVersion {
  $wrangler = Join-Path $PnpmToolsBinDir 'wrangler.cmd'
  if (-not (Test-Path -LiteralPath $wrangler)) { return '' }
  try { (& $wrangler --version 2>$null | Select-Object -Last 1) } catch { '' }
}

function Install-Wrangler {
  $env:PATH = "$PnpmToolsBinDir;$env:PATH"
  if ((Get-WranglerVersion) -eq $WranglerVersion) { return }
  if ($DryRun) { return }
  New-Item -ItemType Directory -Force -Path $PnpmToolsBinDir, $PnpmStoreDir | Out-Null
  $env:PNPM_HOME = $PnpmHome
  Invoke-Checked (Join-Path $PnpmBinDir 'pnpm.cmd') @('add', '--global', '--global-dir', $PnpmToolsDir,
    '--global-bin-dir', $PnpmToolsBinDir, '--store-dir', $PnpmStoreDir, "wrangler@$WranglerVersion")
  $installed = Get-WranglerVersion
  if ($installed -ne $WranglerVersion) { throw "Wrangler $WranglerVersion verification failed: $installed" }
}

function Install-Pulumi {
  $pulumi = Join-Path $PulumiInstallDir 'bin\pulumi.exe'
  if (-not (Test-Path -LiteralPath $pulumi)) {
    if ($DryRun) { return }
    New-Item -ItemType Directory -Force -Path $PulumiHome | Out-Null
    $temp = New-TempDirectory (Join-Path $HostToolsDir 'pulumi')
    try {
      $archive = "pulumi-v$PulumiVersion-$RunnerPulumiPlatform.zip"
      Invoke-KitDownload "https://get.pulumi.com/releases/sdk/$archive" (Join-Path $temp $archive)
      Expand-KitZip (Join-Path $temp $archive) $temp
      if (Test-Path -LiteralPath $PulumiInstallDir) { Remove-Item -LiteralPath $PulumiInstallDir -Recurse -Force }
      New-Item -ItemType Directory -Force -Path $PulumiInstallDir | Out-Null
      # The language hosts and plugins must stay beside pulumi.exe.
      Move-Item -LiteralPath (Join-Path $temp 'pulumi\bin') -Destination (Join-Path $PulumiInstallDir 'bin')
    } finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Write-CmdShim $pulumi (Join-Path $LocalBinDir 'pulumi.cmd')
}

function Get-AwsVersion {
  if (-not (Test-Path -LiteralPath $AwsBinPath)) { return '' }
  try { [string](& $AwsBinPath --version 2>&1) } catch { '' }
}

function Install-Aws {
  if ((Get-AwsVersion) -like "aws-cli/$AwsVersion *") {
    Write-CmdShim $AwsBinPath (Join-Path $LocalBinDir 'aws.cmd')
    return
  }
  if ($DryRun) { return }
  $temp = New-TempDirectory (Join-Path $HostToolsDir 'aws-cli')
  try {
    $package = Join-Path $temp 'AWSCLIV2.msi'
    Invoke-KitDownload $AwsPackageUrl $package
    $signature = Get-AuthenticodeSignature -LiteralPath $package
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|, )O="?Amazon(\.com)?[^,]*') {
      throw 'AWS CLI package is not validly signed by Amazon'
    }
    # An administrative install only unpacks the package, so it needs no
    # elevation and leaves no machine-wide registration.
    $staging = Join-Path $temp 'expanded'
    $process = Start-Process msiexec.exe -ArgumentList @('/a', "`"$package`"", '/qn', "TARGETDIR=`"$staging`"") -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "AWS CLI package extraction failed with exit code $($process.ExitCode)" }
    if (Test-Path -LiteralPath $AwsInstallDir) {
      Move-Item -LiteralPath $AwsInstallDir -Destination "$AwsInstallDir.invalid-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss'))"
    }
    Move-Item -LiteralPath $staging -Destination $AwsInstallDir
  } finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
  $installed = Get-AwsVersion
  if ($installed -notlike "aws-cli/$AwsVersion *") { throw "AWS CLI $AwsVersion verification failed: $installed" }
  Write-CmdShim $AwsBinPath (Join-Path $LocalBinDir 'aws.cmd')
}

if ($PrintManifest) { Get-ManifestContents; exit 0 }
if ($PrintEnv) { Get-EnvFileLines; "PATH=$(Get-RunnerPath)"; exit 0 }
if ($WriteEnv) { Write-EnvFiles; exit 0 }

if (-not $DryRun) {
  foreach ($directory in $RunnerHome, $RunnerTmp, $RunnerTemp, $RunnerToolCache, $LocalBinDir, $PnpmBinDir,
      $CorepackHome, $PnpmToolsBinDir, $PnpmStoreDir, $PulumiHome) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }
}
Install-Node
Install-Pnpm
Install-Wrangler
Install-Pulumi
Install-Aws
if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
  Write-KitText $ManifestPath ((Get-ManifestContents) + "`n")
  Write-EnvFiles
}
