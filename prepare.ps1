# Windows counterpart of prepare.sh: downloads and verifies the pinned runner,
# installs the dashboard dependency, and creates ignored fleet.tsv and
# autoscale.json files from the public examples.
param([switch]$Check)
$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
. (Join-Path $ScriptDir 'platform.ps1')

$RunnerArchivePath = Join-Path $ScriptDir $RunnerArchiveBasename
$FleetPath = Join-Path $ScriptDir 'fleet.tsv'
$FleetExamplePath = Join-Path $ScriptDir 'fleet.example.tsv'
$AutoscalePath = Join-Path $ScriptDir 'autoscale.json'
$PrepareNodeVersion = '24.19.0'
$PreparePnpmVersion = '11.20.0'
$PrepareNodeDir = Join-Path $ScriptDir "host-tools\node-$PrepareNodeVersion-$RunnerNodePlatform"
$PrepareCorepackHome = Join-Path $ScriptDir 'host-tools\corepack'
$PreparePnpmHome = Join-Path $ScriptDir 'host-tools\pnpm'

function Fail([string]$Message) {
  [Console]::Error.WriteLine("prepare failed: $Message")
  exit 1
}

function Test-RunnerArchive {
  (Test-Path -LiteralPath $RunnerArchivePath) -and ((Get-RunnerSha256 $RunnerArchivePath) -eq $RunnerArchiveSha256)
}

Assert-ServicePath $ScriptDir
if ($Check) {
  if (-not (Test-RunnerArchive)) { Fail 'runner archive is missing or has the wrong checksum' }
  if (-not (Test-Path -LiteralPath (Join-Path $ScriptDir 'runnerctl-app\node_modules\blessed'))) {
    [Console]::Error.WriteLine('note: dashboard dependency is not installed; rerun .\prepare.ps1')
  }
  if (-not (Test-Path -LiteralPath $FleetPath)) { Fail 'fleet.tsv is missing; run .\prepare.ps1 and customize it' }
  'source checkout is prepared'
  exit 0
}

if (Test-RunnerArchive) {
  "runner archive ${RunnerVersion}: checksum verified"
} else {
  if (Test-Path -LiteralPath $RunnerArchivePath) { Fail "existing runner archive has the wrong checksum: $RunnerArchivePath" }
  $download = Join-Path $ScriptDir ".runner-download.$([Guid]::NewGuid().ToString('N'))"
  try {
    "downloading GitHub Actions Runner $RunnerVersion for $RunnerPlatform"
    Invoke-KitDownload $RunnerArchiveUrl $download
    if ((Get-RunnerSha256 $download) -ne $RunnerArchiveSha256) { Fail 'downloaded runner archive checksum mismatch' }
    Move-Item -LiteralPath $download -Destination $RunnerArchivePath
  } finally { Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue }
  "runner archive ${RunnerVersion}: checksum verified"
}

if (-not (Test-Path -LiteralPath (Join-Path $PrepareNodeDir 'node.exe')) -or -not (Test-Path -LiteralPath (Join-Path $PrepareNodeDir 'corepack.cmd'))) {
  $archive = "node-v$PrepareNodeVersion-$RunnerNodePlatform"
  $temp = Join-Path $ScriptDir ".prepare-node.$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    "downloading Node.js $PrepareNodeVersion for pnpm-based dashboard preparation"
    Invoke-KitDownload "https://nodejs.org/dist/v$PrepareNodeVersion/$archive.zip" (Join-Path $temp "$archive.zip")
    Expand-KitZip (Join-Path $temp "$archive.zip") $temp
    New-Item -ItemType Directory -Force -Path (Join-Path $ScriptDir 'host-tools') | Out-Null
    if (Test-Path -LiteralPath $PrepareNodeDir) { Remove-Item -LiteralPath $PrepareNodeDir -Recurse -Force }
    Move-Item -LiteralPath (Join-Path $temp $archive) -Destination $PrepareNodeDir
  } finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
}

New-Item -ItemType Directory -Force -Path $PrepareCorepackHome, $PreparePnpmHome | Out-Null
$env:COREPACK_HOME = $PrepareCorepackHome
$env:PNPM_HOME = $PreparePnpmHome
$env:PATH = "$PreparePnpmHome;$PrepareNodeDir;$env:PATH"
$pnpm = Join-Path $PreparePnpmHome 'pnpm.cmd'
$installedPnpm = if (Test-Path -LiteralPath $pnpm) { & $pnpm --version 2>$null | Select-Object -First 1 } else { '' }
if ($installedPnpm -ne $PreparePnpmVersion) {
  & (Join-Path $PrepareNodeDir 'corepack.cmd') install --global "pnpm@$PreparePnpmVersion"
  if ($LASTEXITCODE -ne 0) { Fail 'could not install pnpm' }
  & (Join-Path $PrepareNodeDir 'corepack.cmd') enable --install-directory $PreparePnpmHome pnpm
  if ($LASTEXITCODE -ne 0) { Fail 'could not enable pnpm' }
}

Push-Location -LiteralPath (Join-Path $ScriptDir 'runnerctl-app')
try {
  & $pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { Fail 'dashboard dependency installation failed' }
} finally { Pop-Location }

# Runner directories hold registration credentials; keep their parent private.
$runnersDir = Join-Path $ScriptDir '.runners'
if (-not (Test-Path -LiteralPath $runnersDir)) {
  New-Item -ItemType Directory -Path $runnersDir | Out-Null
  Set-OwnerOnlyAcl $runnersDir
}

if (-not (Test-Path -LiteralPath $FleetPath)) {
  if (-not (Test-Path -LiteralPath $FleetExamplePath)) { Fail "fleet example is missing: $FleetExamplePath" }
  Copy-Item -LiteralPath $FleetExamplePath -Destination $FleetPath
  "created $FleetPath"
}

if (-not (Test-DeveloperMode)) {
  ''
  'note: Developer Mode is off, so jobs cannot create symlinks and Git checks them out as plain files.'
  '      Enable it once from an elevated PowerShell, then reprovision runners:'
  "      reg add HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock /t REG_DWORD /f /v AllowDevelopmentWithoutDevLicense /d 1"
}

''
if (-not (Test-Path -LiteralPath $AutoscalePath)) {
  # The public template uses Linux labels; Windows jobs request these instead.
  $config = Read-KitText (Join-Path $ScriptDir 'autoscale.example.json') | ConvertFrom-Json
  $config.labels = @('self-hosted', 'Windows', 'X64')
  Write-KitText $AutoscalePath (($config | ConvertTo-Json -Depth 5) + "`n")
  Set-OwnerOnlyAcl $AutoscalePath
}
'preparation complete'
'next: edit autoscale.json for your account, then run .\runnerctl autoscale --prepare'
'autoscaling is enabled automatically after slot preparation'
