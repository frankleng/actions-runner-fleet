# Windows service manager for one runner directory, the counterpart of
# svc-systemd-user.sh: a headless scheduled task runs runsvc.ps1 at boot.
param(
  [Parameter(Position = 0)][string]$Command = 'status',
  [Parameter(Position = 1)][string]$Value = '',
  [Parameter(Position = 2)][string]$Option = ''
)
$ErrorActionPreference = 'Stop'
$RunnerRoot = $PSScriptRoot
. (Join-Path $RunnerRoot 'runner-common.ps1')

function Fail([string]$Message) {
  [Console]::Error.WriteLine("Failed: $Message")
  exit 1
}

$metadataPath = Join-Path $RunnerRoot '.runner'
# Slot identity survives the ephemeral runner's automatic deregistration.
if (Test-Path -LiteralPath (Join-Path $RunnerRoot '.autoscale-slot.json')) {
  $metadataPath = Join-Path $RunnerRoot '.autoscale-slot.json'
}
if (-not (Test-Path -LiteralPath $metadataPath)) { Fail "runner metadata missing: $metadataPath" }
$metadata = Read-KitText $metadataPath | ConvertFrom-Json
$RunnerName = [string]$metadata.agentName
$RunnerOwner = ([string]$metadata.gitHubUrl).TrimEnd('/').Split('/')[-1]
$SvcName = "actions.runner.$RunnerOwner.$RunnerName".Replace(' ', '_')
if ($SvcName -notmatch '^[A-Za-z0-9_.-]+$') { Fail 'Unsupported service identity' }

# GitHub's runner self-update replaces bin/; prefer the kit's own copies while
# the kit is on disk, like svc-systemd-user.sh.
$KitOverlayDirectory = $null
$kitRootFile = Join-Path $RunnerRoot '.kit-root'
if (Test-Path -LiteralPath $kitRootFile) { $KitOverlayDirectory = Join-Path (Read-KitText $kitRootFile).Trim() 'overlay' }
function Get-KitOrRunnerFile([string]$Leaf) {
  if ($KitOverlayDirectory -and (Test-Path -LiteralPath (Join-Path $KitOverlayDirectory $Leaf))) { return Join-Path $KitOverlayDirectory $Leaf }
  Join-Path $RunnerRoot $Leaf
}

$ConfigPath = Join-Path $RunnerRoot '.service'
$CpuQuotaPath = Join-Path $RunnerRoot '.cpu-quota'
$RunsvcPath = Join-Path $RunnerRoot 'runsvc.ps1'
$SupervisorPidFile = Join-Path $RunnerRoot '.svc.pid'
$LiveCpuRatePath = Join-Path $RunnerRoot '.svc-cpu-rate'
$StopRequestPath = Join-Path $RunnerRoot '.svc-stop-request'
$StopGraceSeconds = if ($env:RUNNER_STOP_GRACE_SECONDS) { [int]$env:RUNNER_STOP_GRACE_SECONDS } else { 30 }
$MaxCpuQuotaPercent = [Environment]::ProcessorCount * 100

function Import-Native {
  Import-RunnerFleetNative (Join-Path $RunnerRoot 'RunnerFleetNative.cs') (Join-Path $RunnerRoot '.native')
}

function Assert-CpuQuota([string]$Quota) {
  if ($Quota -notmatch '^\d+$') { Fail "CPU quota must be a whole-number percent (received '$Quota')" }
  if ([long]$Quota -lt 1) { Fail 'CPU quota must be at least 1%' }
  if ([long]$Quota -gt $MaxCpuQuotaPercent) {
    Fail "CPU quota must not exceed $MaxCpuQuotaPercent% ($([Environment]::ProcessorCount) logical CPUs available)"
  }
}

function Save-CpuQuota([string]$Quota) {
  Assert-CpuQuota $Quota
  Write-KitText $CpuQuotaPath "$Quota`n"
}

# Reports the supervisor job's hard cap as "<percent> 100" so the autoscaler
# can verify it the way it reads a cgroup's cpu.max on Linux. The supervisor
# publishes the rate it read back from its job; trust it only while it runs.
function Get-LiveCpuQuota([int]$Supervisor) {
  if (-not $Supervisor -or -not (Test-Path -LiteralPath $LiveCpuRatePath)) { return $null }
  $rate = 0
  if (-not [int]::TryParse((Read-KitText $LiveCpuRatePath).Trim(), [ref]$rate)) { return $null }
  if ($rate -eq 0) { return 'max 100' }
  $cpuCount = [Environment]::ProcessorCount
  $saved = Read-RunnerCpuQuota $CpuQuotaPath
  # Mirrors RunnerFleet.Native.CpuRateForQuota without loading the assembly.
  $expected = [Math]::Max(1, [Math]::Min(10000, [Math]::Round($saved * 100.0 / $cpuCount, [MidpointRounding]::ToEven)))
  if ($rate -eq $expected) { return "$saved 100" }
  '{0:0.##} 100' -f ($rate * $cpuCount / 100)
}

function Install-RunnerService {
  if ($KitOverlayDirectory) {
    # Refresh .env, .path, and home .npmrc, like ./env.sh on Linux and macOS.
    & $KitPowerShell @KitPowerShellArguments -File (Join-Path (Split-Path $KitOverlayDirectory) 'provision-runner-tooling.ps1') -Root $RunnerRoot -WriteEnv
    if ($LASTEXITCODE -ne 0) { Fail 'could not refresh the runner environment' }
  }
  # PowerShell reads a script fully before running it, so replacing the file
  # under a running supervisor is safe.
  Copy-Item -LiteralPath (Get-KitOrRunnerFile 'runsvc.ps1') -Destination "$RunsvcPath.tmp" -Force
  Move-Item -LiteralPath "$RunsvcPath.tmp" -Destination $RunsvcPath -Force
  Save-CpuQuota ([string](Read-RunnerCpuQuota $CpuQuotaPath))
  Register-KitTask -Name $SvcName -Script $RunsvcPath -WorkingDirectory $RunnerRoot -Trigger Startup `
    -Description "GitHub Actions Runner ($RunnerName)"
  Write-KitText $ConfigPath "$KitTaskFolder$SvcName`n"
  'svc install complete'
}

function Show-Status {
  "status ${SvcName}:"
  ''
  "CPU limit: $(Read-RunnerCpuQuota $CpuQuotaPath)%"
  ''
  $state = Get-KitTaskState $SvcName
  if (-not (Test-Path -LiteralPath $ConfigPath) -or -not $state) { 'not installed'; ''; return }
  "$KitTaskFolder$SvcName"
  ''
  if ($state -eq 'Disabled') { 'Disabled'; ''; return }
  if ($state -eq 'Running') {
    $supervisor = Get-OwnedProcessId $SupervisorPidFile $RunsvcPath
    $live = Get-LiveCpuQuota $supervisor
    if ($live) { "Live CPU quota: $live" }
    'Started:'
    "$(if ($supervisor) { $supervisor } else { 0 }) 0 $SvcName"
  } else {
    'Stopped'
  }
  ''
}

function Start-RunnerService {
  if (-not (Test-Path -LiteralPath $ConfigPath) -or -not (Get-KitTaskState $SvcName)) { Install-RunnerService | Out-Null }
  Remove-Item -LiteralPath $StopRequestPath -Force -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskPath $KitTaskFolder -TaskName $SvcName
  for ($attempt = 0; $attempt -lt 20 -and -not (Get-OwnedProcessId $SupervisorPidFile $RunsvcPath); $attempt++) {
    Start-Sleep -Milliseconds 500
  }
}

# Windows has no SIGTERM. The supervisor sees the stop request and raises
# Ctrl+C on the listener's console (consoles cannot be reached from another
# logon session), then this ends the supervisor, and with it the job, once
# the grace period lapses.
function Stop-RunnerService {
  $supervisor = Get-OwnedProcessId $SupervisorPidFile $RunsvcPath
  if ($supervisor) {
    Write-KitText $StopRequestPath "stop`n"
    $deadline = (Get-Date).AddSeconds($StopGraceSeconds)
    while ((Get-Process -Id $supervisor -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
    }
  }
  Stop-KitTask $SvcName $SupervisorPidFile $RunsvcPath
}

switch ($Command) {
  'install' { Install-RunnerService }
  'start' { Start-RunnerService; Show-Status }
  'stop' { if (Get-KitTaskState $SvcName) { Stop-RunnerService }; Show-Status }
  'status' { Show-Status }
  'set-cpu-limit' {
    # Option may be --defer-reload from the autoscaler; there is nothing to reload.
    Save-CpuQuota $Value
    "CPU limit for ${RunnerName}: $Value%"
  }
  'uninstall' {
    if (Get-KitTaskState $SvcName) { Stop-RunnerService }
    Unregister-KitTask $SvcName $SupervisorPidFile $RunsvcPath
    Remove-Item -LiteralPath $ConfigPath -Force -ErrorAction SilentlyContinue
  }
  'prune-logs' {
    $days = if ($env:RUNNER_LOG_RETENTION_DAYS) { [int]$env:RUNNER_LOG_RETENTION_DAYS } else { 7 }
    $cutoff = (Get-Date).AddDays(-$days)
    Get-ChildItem -LiteralPath (Join-Path $RunnerRoot '_diag') -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -lt $cutoff } | Remove-Item -Force -ErrorAction SilentlyContinue
  }
  'send-ctrl-c' {
    Import-Native
    exit ([int](-not [RunnerFleet.Native]::SendCtrlC([uint32]$Value)))
  }
  default {
    [Console]::Error.WriteLine('Usage: .\svc.ps1 [install|start|stop|status|set-cpu-limit <percent>|uninstall|prune-logs]')
    exit 1
  }
}
