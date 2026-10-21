# Windows counterpart of manage-runners.sh, sharing its runners.tsv registry
# and subcommands. Compatible with Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
$RootDir = $PSScriptRoot
. (Join-Path $RootDir 'platform.ps1')

$RegistryPath = if ($env:RUNNER_REGISTRY_PATH) { $env:RUNNER_REGISTRY_PATH } else { Join-Path $RootDir 'runners.tsv' }
$DefaultUrl = $env:RUNNER_DEFAULT_URL
$ArchivePath = if ($env:RUNNER_ARCHIVE_PATH) { $env:RUNNER_ARCHIVE_PATH } else { Join-Path $RootDir $RunnerArchiveBasename }
$ImageDir = if ($env:RUNNER_IMAGE_DIR) { $env:RUNNER_IMAGE_DIR } else { ($ArchivePath -replace '\.zip$', '') + '.image' }
$OverlayDir = if ($env:RUNNER_OVERLAY_DIR) { $env:RUNNER_OVERLAY_DIR } else { Join-Path $RootDir 'overlay' }
$ProvisionScriptPath = if ($env:RUNNER_PROVISION_SCRIPT_PATH) { $env:RUNNER_PROVISION_SCRIPT_PATH } else { Join-Path $RootDir 'provision-runner-tooling.ps1' }
$Labels = $env:RUNNER_LABELS
$NoDefaultLabels = if ($env:RUNNER_NO_DEFAULT_LABELS) { $env:RUNNER_NO_DEFAULT_LABELS } else { '0' }
$SelfName = Split-Path -Leaf $PSCommandPath

function Fail([string]$Message) {
  [Console]::Error.WriteLine($Message)
  exit 1
}

function Show-Usage {
  @"
Usage:
  .\$SelfName help
  .\$SelfName list
  .\$SelfName track <name> <runner_dir>
  .\$SelfName reconcile <name>
  .\$SelfName reconcile-all
  .\$SelfName prepare-autoscale <name> <target_url>
  .\$SelfName register <name> <token> <target_url> [runner_dir]
  .\$SelfName install-service <name>
  .\$SelfName start <name>
  .\$SelfName stop <name>
  .\$SelfName status <name>
  .\$SelfName set-cpu-limit <name> <percent>

Notes:
  - .\config.cmd is only needed once per new runner directory.
  - Each runner must live in its own directory and have its own name.
  - New runners default to $RootDir\.runners\<runner-name>.
  - Services are per-user scheduled tasks in $KitTaskFolder that start at logon.
  - Set RUNNER_DEFER_RECONCILE=1 to register quickly and provision later.
  - Set RUNNER_REPLACE_EXISTING=1 to replace a GitHub runner with the same name.
  - Target URLs may identify a repository (OWNER/REPOSITORY), organization
    (ORGANIZATION), or enterprise (enterprises/ENTERPRISE) under github.com.
  - Runner CPU limits are whole-number percentages; 100% equals one CPU,
    and the maximum matches the logical CPUs available to this process.
  - RUNNER_LABELS adds comma-separated custom labels during registration.
  - RUNNER_NO_DEFAULT_LABELS=1 makes jobs require a custom runner label.
  - The registry lives at: $RegistryPath
"@
}

function Get-TrackedRunners {
  if (-not (Test-Path -LiteralPath $RegistryPath)) { return @() }
  foreach ($line in (Read-KitText $RegistryPath) -split "`r?`n") {
    $fields = $line.Split("`t")
    if ($fields.Count -ge 2 -and $fields[0] -and $fields[1]) { [pscustomobject]@{ Name = $fields[0]; Directory = $fields[1] } }
  }
}

function Get-RunnerDirectory([string]$Name) {
  (Get-TrackedRunners | Where-Object { $_.Name -ceq $Name } | Select-Object -First 1).Directory
}

function Get-RequiredRunnerDirectory([string]$Name) {
  $directory = Get-RunnerDirectory $Name
  if (-not $directory) { Fail "runner '$Name' is not tracked in $RegistryPath" }
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) { Fail "tracked directory does not exist: $directory" }
  $directory
}

function Add-TrackedRunner([string]$Name, [string]$Directory) {
  if (Get-RunnerDirectory $Name) { Fail "runner '$Name' is already tracked" }
  Add-KitText $RegistryPath "$Name`t$Directory`n"
  "tracked $Name -> $Directory"
}

function Show-TrackedRunners {
  $runners = @(Get-TrackedRunners)
  if (-not $runners.Count) { 'no runners tracked'; return }
  '{0,-24} {1}' -f 'NAME', 'DIRECTORY'
  foreach ($runner in $runners) { '{0,-24} {1}' -f $runner.Name, $runner.Directory }
}

function Get-DefaultRunnerDirectory([string]$Name) {
  Join-Path $RootDir ('.runners\' + (($Name -replace '[^A-Za-z0-9._-]+', '-').Trim('-')))
}

# Runner directories hold registration credentials. Default Windows ACLs let
# every local user read new folders, so restrict them like chmod 700 before
# anything is copied in; copies then inherit the restricted list.
function New-PrivateRunnerDirectory([string]$Directory) {
  $parent = Split-Path -Parent $Directory
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Set-OwnerOnlyAcl $parent
  }
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  Set-OwnerOnlyAcl $Directory
}

function Invoke-RunnerSvc([string]$Directory, [string[]]$Arguments) {
  & $KitPowerShell @KitPowerShellArguments -File (Join-Path $Directory 'svc.ps1') @Arguments
  if ($LASTEXITCODE -ne 0) { throw "svc.ps1 $($Arguments -join ' ') failed for $Directory" }
}

function Copy-Overlay([string]$Directory) {
  Assert-ServicePath $Directory
  foreach ($leaf in 'svc.ps1', 'runsvc.ps1', 'runner-common.ps1', 'RunnerFleetNative.cs', 'runner-job-temp.ps1', 'autoscale-lock.mjs', 'autoscale-worker.mjs') {
    if (-not (Test-Path -LiteralPath (Join-Path $OverlayDir $leaf))) { Fail "managed runner overlay file is missing: $(Join-Path $OverlayDir $leaf)" }
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $Directory 'bin'), (Join-Path $Directory 'job-hooks') | Out-Null
  Write-KitText (Join-Path $Directory '.kit-root') "$RootDir`n"
  foreach ($leaf in 'svc.ps1', 'runsvc.ps1', 'runner-common.ps1', 'RunnerFleetNative.cs') {
    Copy-Item -LiteralPath (Join-Path $OverlayDir $leaf) -Destination (Join-Path $Directory $leaf) -Force
  }
  foreach ($leaf in 'autoscale-lock.mjs', 'autoscale-worker.mjs') {
    Copy-Item -LiteralPath (Join-Path $OverlayDir $leaf) -Destination (Join-Path $Directory "bin\$leaf") -Force
  }
  foreach ($phase in 'started', 'completed') {
    Copy-Item -LiteralPath (Join-Path $OverlayDir 'runner-job-temp.ps1') -Destination (Join-Path $Directory "job-hooks\runner-job-$phase.ps1") -Force
  }
}

function Initialize-RuntimeRoots([string]$Directory) {
  foreach ($leaf in 'home', 'tmp', '_work\_temp', 'tools') {
    New-Item -ItemType Directory -Force -Path (Join-Path $Directory $leaf) | Out-Null
  }
}

function Invoke-Provisioning([string]$Directory) {
  if (-not (Test-Path -LiteralPath $ProvisionScriptPath)) { Fail "provisioning script is missing: $ProvisionScriptPath" }
  & $KitPowerShell @KitPowerShellArguments -File $ProvisionScriptPath -Root $Directory
  if ($LASTEXITCODE -ne 0) { throw "runner tooling provisioning failed for $Directory" }
}

function Update-RunnerDirectory([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { Fail "tracked directory does not exist: $Directory" }
  if (-not (Test-Path -LiteralPath (Join-Path $Directory '.runner')) -and -not (Test-Path -LiteralPath (Join-Path $Directory '.autoscale-slot.json'))) {
    Fail "runner metadata not found in $(Join-Path $Directory '.runner')"
  }
  # Credentials live here; never provision into a directory others can read.
  try { Assert-OwnerOnlyAcl $Directory }
  catch { Fail "$($_.Exception.Message); restrict it to this user, SYSTEM, and Administrators (for example with icacls /inheritance:r) and retry" }
  Copy-Overlay $Directory
  Initialize-RuntimeRoots $Directory
  Invoke-Provisioning $Directory
  Invoke-RunnerSvc $Directory @('install')
  "reconciled $Directory"
}

function Wait-RunnerStart([string]$Directory) {
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    $output = & $KitPowerShell @KitPowerShellArguments -File (Join-Path $Directory 'svc.ps1') status 2>&1 | Out-String
    if ($output -match 'Started:') { return }
    Start-Sleep -Seconds 1
  }
  Fail "runner did not report started status after reconcile: $Directory"
}

# Supervisors, listeners, workers, and job steps all run from the runner
# directory; anything still executing from it after a stop is a leftover.
function Get-RunnerProcesses([string]$Directory) {
  $prefix = $Directory.TrimEnd('\') + '\'
  Get-CimInstance Win32_Process | Where-Object {
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) -or
    ($_.CommandLine -and $_.CommandLine.IndexOf((Join-Path $Directory 'runsvc.ps1'), [StringComparison]::OrdinalIgnoreCase) -ge 0)
  }
}

function Confirm-RunnerStopped([string]$Directory) {
  $processes = @(Get-RunnerProcesses $Directory)
  if (-not $processes.Count) { return }
  "detected lingering runner processes in $Directory; terminating"
  $processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  $remaining = @(Get-RunnerProcesses $Directory)
  if ($remaining.Count) { Fail "failed to stop all runner processes in ${Directory}; remaining PIDs: $(($remaining | ForEach-Object ProcessId) -join ' ')" }
  "runner processes terminated for $Directory"
}

function Update-AllRunners {
  foreach ($runner in @(Get-TrackedRunners)) {
    "rolling reconcile for $($runner.Name)"
    if (Test-Path -LiteralPath (Join-Path $runner.Directory 'svc.ps1')) {
      try { Invoke-RunnerSvc $runner.Directory @('stop') } catch { }
      Confirm-RunnerStopped $runner.Directory
    }
    Update-RunnerDirectory $runner.Directory
    Invoke-RunnerSvc $runner.Directory @('start')
    Wait-RunnerStart $runner.Directory
  }
}

# Extract the runner archive once; each runner directory is a copy of the
# image. NTFS has no copy-on-write clones, so each copy uses its own space.
function Initialize-RunnerImage {
  if (Test-Path -LiteralPath $ImageDir) { return }
  if (-not (Test-Path -LiteralPath $ArchivePath)) { Fail "runner archive not found: $ArchivePath" }
  $staging = Join-Path (Split-Path -Parent $ImageDir) ".runner-image.$([Guid]::NewGuid().ToString('N'))"
  Expand-KitZip $ArchivePath $staging
  if (Test-Path -LiteralPath $ImageDir) { Remove-Item -LiteralPath $staging -Recurse -Force }
  else { Move-Item -LiteralPath $staging -Destination $ImageDir }
}

function Copy-RunnerImage([string]$Directory) {
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  & robocopy.exe $ImageDir $Directory /E /COPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  # robocopy exit codes below 8 mean success.
  if ($LASTEXITCODE -ge 8) { throw "could not copy the runner image to $Directory (robocopy $LASTEXITCODE)" }
}

# Provision a new, unregistered slot. Never convert or replace an existing runner.
function New-AutoscaleSlot([string]$Name, [string]$Url) {
  if ($Name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') { Fail 'invalid slot name' }
  $scope = Get-GitHubRunnerScope $Url
  if (-not $scope) { Fail 'GitHub target must be a repository or organization URL under https://github.com/' }
  if ($scope -eq 'enterprise') { Fail 'autoscaling does not support enterprise scope' }
  if (Get-RunnerDirectory $Name) { Fail 'slot name is already tracked' }
  $directory = Get-DefaultRunnerDirectory $Name
  if (Test-Path -LiteralPath $directory) { Fail 'slot directory already exists' }
  Assert-ServicePath $directory
  Initialize-RunnerImage
  New-PrivateRunnerDirectory $directory
  Copy-RunnerImage $directory
  $slot = [ordered]@{ agentName = $Name; gitHubUrl = $Url; version = 1 } | ConvertTo-Json -Compress
  Write-KitText (Join-Path $directory '.autoscale-slot.json') "$slot`n"
  Add-TrackedRunner $Name $directory
  Update-RunnerDirectory $directory
  Write-KitText (Join-Path $directory '.autoscale-prepared') ''
}

function Register-Runner([string]$Name, [string]$Token, [string]$Url, [string]$Directory) {
  if (-not $Url) { $Url = $DefaultUrl }
  if (-not $Directory) { $Directory = Get-DefaultRunnerDirectory $Name }
  Assert-ServicePath $Directory
  switch ($NoDefaultLabels) {
    '0' { }
    '1' { if (-not $Labels) { Fail 'RUNNER_LABELS is required when RUNNER_NO_DEFAULT_LABELS=1' } }
    default { Fail 'RUNNER_NO_DEFAULT_LABELS must be 0 or 1' }
  }
  if (-not $Url) { Fail 'GitHub repository, organization, or enterprise URL is required' }
  if (-not (Get-GitHubRunnerScope $Url)) { Fail 'GitHub target must be a repository, organization, or enterprise URL under https://github.com/' }
  if (Get-RunnerDirectory $Name) { Fail "runner '$Name' is already tracked" }
  if (-not (Test-Path -LiteralPath $ArchivePath)) { Fail "runner archive not found: $ArchivePath" }
  if ((Test-Path -LiteralPath $Directory) -and (Get-ChildItem -LiteralPath $Directory -Force | Select-Object -First 1)) {
    Fail "target directory is not empty: $Directory"
  }
  Initialize-RunnerImage
  New-PrivateRunnerDirectory $Directory
  Copy-RunnerImage $Directory

  $configArguments = @('--unattended', '--url', $Url, '--token', $Token, '--name', $Name, '--work', '_work')
  if ($env:RUNNER_REPLACE_EXISTING -eq '1') { $configArguments += '--replace' }
  if ($NoDefaultLabels -eq '1') { $configArguments += '--no-default-labels' }
  if ($Labels) { $configArguments += @('--labels', $Labels) }
  Push-Location -LiteralPath $Directory
  try {
    & (Join-Path $Directory 'config.cmd') @configArguments
    if ($LASTEXITCODE -ne 0) { throw "runner configuration failed for $Name" }
  } finally { Pop-Location }

  Add-TrackedRunner $Name $Directory
  if ($env:RUNNER_DEFER_RECONCILE -eq '1') { "registered $Name; provisioning deferred"; return }
  Update-RunnerDirectory $Directory
}

function Invoke-ServiceCommand([string]$Name, [string]$ServiceCommand, [bool]$Reconcile = $false) {
  $directory = Get-RequiredRunnerDirectory $Name
  if ($Reconcile) { Update-RunnerDirectory $directory }
  Invoke-RunnerSvc $directory @($ServiceCommand)
  if ($ServiceCommand -eq 'stop') { Confirm-RunnerStopped $directory }
}

function Set-RunnerCpuLimit([string]$Name, [string]$Percent) {
  if ($Percent -notmatch '^\d+$') { Fail "CPU quota must be a whole-number percent (received '$Percent')" }
  $cpuCount = Get-AvailableCpuCount
  $max = $cpuCount * 100
  if ([long]$Percent -lt 1 -or [long]$Percent -gt $max) { Fail "CPU quota must be between 1% and $max% ($cpuCount logical CPUs available)" }
  $directory = Get-RequiredRunnerDirectory $Name
  if (Test-Path -LiteralPath (Join-Path $directory 'svc.ps1')) {
    Invoke-RunnerSvc $directory @('set-cpu-limit', $Percent)
    return
  }
  Write-KitText (Join-Path $directory '.cpu-quota') "$Percent`n"
  "CPU limit for ${Name}: $Percent% (applies when the managed service is installed)"
}

Assert-ServicePath $RootDir
$cliArgs = @($args)
$command = if ($cliArgs.Count) { $cliArgs[0] } else { 'help' }
$count = $cliArgs.Count
try {
  switch ($command) {
    { $_ -in 'help', '-h', '--help' } { Show-Usage }
    'list' { Show-TrackedRunners }
    'track' { if ($count -ne 3) { Show-Usage; exit 1 }; Add-TrackedRunner $cliArgs[1] $cliArgs[2] }
    'reconcile' { if ($count -ne 2) { Show-Usage; exit 1 }; Update-RunnerDirectory (Get-RequiredRunnerDirectory $cliArgs[1]) }
    'reconcile-all' { if ($count -ne 1) { Show-Usage; exit 1 }; Update-AllRunners }
    'prepare-autoscale' { if ($count -ne 3) { Show-Usage; exit 1 }; New-AutoscaleSlot $cliArgs[1] $cliArgs[2] }
    'register' { if ($count -lt 3 -or $count -gt 5) { Show-Usage; exit 1 }; Register-Runner $cliArgs[1] $cliArgs[2] $cliArgs[3] $cliArgs[4] }
    'install-service' { if ($count -ne 2) { Show-Usage; exit 1 }; Invoke-ServiceCommand $cliArgs[1] 'install' $true }
    'start' { if ($count -ne 2) { Show-Usage; exit 1 }; Invoke-ServiceCommand $cliArgs[1] 'start' $true }
    'stop' { if ($count -ne 2) { Show-Usage; exit 1 }; Invoke-ServiceCommand $cliArgs[1] 'stop' }
    'status' { if ($count -ne 2) { Show-Usage; exit 1 }; Invoke-ServiceCommand $cliArgs[1] 'status' }
    'set-cpu-limit' { if ($count -ne 3) { Show-Usage; exit 1 }; Set-RunnerCpuLimit $cliArgs[1] $cliArgs[2] }
    default { Show-Usage; exit 1 }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
