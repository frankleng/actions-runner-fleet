# Runner supervisor started by the runner's scheduled task: the Windows
# counterpart of runsvc.sh plus systemd's Restart=always, CPUQuota=, and
# KillMode=control-group.
$ErrorActionPreference = 'Stop'
$RunnerRoot = $PSScriptRoot
Set-Location -LiteralPath $RunnerRoot
. (Join-Path $RunnerRoot 'runner-common.ps1')

$DiagDirectory = Join-Path $RunnerRoot '_diag'
$SupervisorLogPath = Join-Path $DiagDirectory 'runsvc-supervisor.log'
$CpuQuotaPath = Join-Path $RunnerRoot '.cpu-quota'
$StopRequestPath = Join-Path $RunnerRoot '.svc-stop-request'
$LiveCpuRatePath = Join-Path $RunnerRoot '.svc-cpu-rate'
$LogPruneIntervalSeconds = if ($env:RUNNER_LOG_PRUNE_INTERVAL_SECONDS) { [int]$env:RUNNER_LOG_PRUNE_INTERVAL_SECONDS } else { 3600 }
$LogRotateMaxBytes = if ($env:RUNNER_LOG_ROTATE_MAX_BYTES) { [long]$env:RUNNER_LOG_ROTATE_MAX_BYTES } else { 52428800 }
New-Item -ItemType Directory -Force -Path $DiagDirectory | Out-Null

function Write-SupervisorLog([string]$Message) {
  [IO.File]::AppendAllText($SupervisorLogPath, "[$((Get-Date).ToString('o'))] $Message`r`n")
}

function Test-ReparsePoint([string]$Path) {
  (Test-Path -LiteralPath $Path) -and ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Test-SamePath([string]$Left, [string]$Right) {
  $Left -and $Right -and ([IO.Path]::GetFullPath($Left) -ieq [IO.Path]::GetFullPath($Right))
}

# The listener reads .env itself; load it here too so the slot worker and the
# job hooks see the same environment, as runsvc.sh does.
function Import-RunnerEnvironment {
  $envPath = Join-Path $RunnerRoot '.env'
  if (Test-Path -LiteralPath $envPath) {
    foreach ($line in (Read-KitText $envPath) -split "`r?`n") {
      if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
      }
    }
  }
  $pathFile = Join-Path $RunnerRoot '.path'
  if (Test-Path -LiteralPath $pathFile) { $env:PATH = (Read-KitText $pathFile).Trim() }
}

# A runner self-update replaces bin/ and drops the kit's autoscale scripts.
function Restore-KitBinFiles {
  $kitRootFile = Join-Path $RunnerRoot '.kit-root'
  if (-not (Test-Path -LiteralPath $kitRootFile)) { return }
  $kitOverlay = Join-Path (Read-KitText $kitRootFile).Trim() 'overlay'
  foreach ($leaf in 'autoscale-lock.mjs', 'autoscale-worker.mjs') {
    $target = Join-Path $RunnerRoot "bin\$leaf"
    $source = Join-Path $kitOverlay $leaf
    if (-not (Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $source)) { Copy-Item -LiteralPath $source -Destination $target }
  }
}

function Open-ChildLog([string]$Leaf) {
  $path = Join-Path $DiagDirectory $Leaf
  if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt $LogRotateMaxBytes) {
    Move-Item -LiteralPath $path -Destination "$path.1" -Force
  }
  New-Object IO.FileStream $path, ([IO.FileMode]::Append), ([IO.FileAccess]::Write), ([IO.FileShare]::ReadWrite)
}

# The child gets its own hidden console so svc.ps1 can deliver Ctrl+C to it
# without touching this supervisor.
function Start-RunnerChild {
  if (Test-Path -LiteralPath (Join-Path $RunnerRoot '.autoscale-slot.json')) {
    $info = New-Object Diagnostics.ProcessStartInfo (Join-Path $RunnerRoot 'externals\node24\bin\node.exe'), '.\bin\autoscale-worker.mjs'
  } else {
    $info = New-Object Diagnostics.ProcessStartInfo (Join-Path $RunnerRoot 'bin\Runner.Listener.exe'), 'run --startuptype service'
  }
  $info.WorkingDirectory = $RunnerRoot
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($info)
  $stdout = Open-ChildLog 'runsvc.log'
  $stderr = Open-ChildLog 'runsvc.err.log'
  [pscustomobject]@{
    Process = $process
    Logs = @($stdout, $stderr)
    Copies = @($process.StandardOutput.BaseStream.CopyToAsync($stdout), $process.StandardError.BaseStream.CopyToAsync($stderr))
  }
}

try {
  Import-RunnerFleetNative (Join-Path $RunnerRoot 'RunnerFleetNative.cs') (Join-Path $RunnerRoot '.native')
  # Joining the job first makes every process started below inherit the CPU
  # cap and end with this supervisor, even after a crash or forced stop.
  $job = [RunnerFleet.Native]::CreateSupervisorJob((Get-KitJobName $RunnerRoot))
  $cpuCount = [Environment]::ProcessorCount
  $script:appliedRate = $null
  Remove-Item -LiteralPath $LiveCpuRatePath -Force -ErrorAction SilentlyContinue
  function Update-CpuQuota {
    try { $rate = [RunnerFleet.Native]::CpuRateForQuota((Read-RunnerCpuQuota $CpuQuotaPath), $cpuCount) }
    catch {
      # Keep the last valid cap while the file is replaced or mistyped.
      if ($null -eq $script:appliedRate) { throw }
      return
    }
    if ($rate -ne $script:appliedRate) {
      [RunnerFleet.Native]::SetCpuRate($job, $rate)
      $script:appliedRate = $rate
      # Read back what the kernel enforces for svc.ps1 status in any session.
      Write-KitText $LiveCpuRatePath "$([RunnerFleet.Native]::QueryCpuRate($job))`n"
    }
  }
  Update-CpuQuota
  Remove-Item -LiteralPath $StopRequestPath -Force -ErrorAction SilentlyContinue
  Write-KitText (Join-Path $RunnerRoot '.svc.pid') "$PID`n"

  $ambientStartedHook = $env:ACTIONS_RUNNER_HOOK_JOB_STARTED
  $ambientCompletedHook = $env:ACTIONS_RUNNER_HOOK_JOB_COMPLETED
  Import-RunnerEnvironment

  # Keep job scratch files out of the account's shared temporary directory.
  # GitHub invokes the hooks synchronously, so cleanup never runs mid-job.
  $jobTemp = Join-Path $RunnerRoot 'tmp\managed-job'
  if ((Test-ReparsePoint (Join-Path $RunnerRoot 'tmp')) -or (Test-ReparsePoint $jobTemp)) {
    throw 'Runner temporary directory must not be a symlink or junction'
  }
  New-Item -ItemType Directory -Force -Path $jobTemp | Out-Null
  $env:TMPDIR = $jobTemp
  $env:TMP = $jobTemp
  $env:TEMP = $jobTemp

  $startedHook = Join-Path $RunnerRoot 'job-hooks\runner-job-started.ps1'
  $completedHook = Join-Path $RunnerRoot 'job-hooks\runner-job-completed.ps1'
  if ($ambientStartedHook -and -not (Test-SamePath $ambientStartedHook $startedHook)) {
    $env:RUNNER_PREVIOUS_JOB_STARTED_HOOK = $ambientStartedHook
  } elseif (-not (Test-SamePath $env:ACTIONS_RUNNER_HOOK_JOB_STARTED $startedHook)) {
    $env:RUNNER_PREVIOUS_JOB_STARTED_HOOK = $env:ACTIONS_RUNNER_HOOK_JOB_STARTED
  }
  if ($ambientCompletedHook -and -not (Test-SamePath $ambientCompletedHook $completedHook)) {
    $env:RUNNER_PREVIOUS_JOB_COMPLETED_HOOK = $ambientCompletedHook
  } elseif (-not (Test-SamePath $env:ACTIONS_RUNNER_HOOK_JOB_COMPLETED $completedHook)) {
    $env:RUNNER_PREVIOUS_JOB_COMPLETED_HOOK = $env:ACTIONS_RUNNER_HOOK_JOB_COMPLETED
  }
  $env:ACTIONS_RUNNER_HOOK_JOB_STARTED = $startedHook
  $env:ACTIONS_RUNNER_HOOK_JOB_COMPLETED = $completedHook

  $svcScript = Join-Path $RunnerRoot 'svc.ps1'
  $nextPrune = Get-Date
  Restore-KitBinFiles
  while ($true) {
    $child = Start-RunnerChild
    Write-SupervisorLog "started child $($child.Process.Id)"
    $stopSignalled = $false
    while (-not $child.Process.WaitForExit(1000)) {
      Update-CpuQuota
      if (-not $stopSignalled -and (Test-Path -LiteralPath $StopRequestPath)) {
        # The sender gives up its own console, so it must be a disposable process.
        $stopSignalled = $true
        & $KitPowerShell @KitPowerShellArguments -File $svcScript send-ctrl-c $child.Process.Id | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-SupervisorLog "sent Ctrl+C to child $($child.Process.Id) on stop request" }
        else { Write-SupervisorLog "could not deliver Ctrl+C to child $($child.Process.Id); svc.ps1 stop ends the job after its grace period" }
      }
      if ($LogPruneIntervalSeconds -gt 0 -and (Get-Date) -ge $nextPrune) {
        & $svcScript prune-logs 2>$null | Out-Null
        $nextPrune = (Get-Date).AddSeconds($LogPruneIntervalSeconds)
      }
    }
    $code = $child.Process.ExitCode
    [Threading.Tasks.Task]::WaitAll($child.Copies, 5000) | Out-Null
    $child.Logs | ForEach-Object { $_.Dispose() }
    Write-SupervisorLog "child exited with code $code"
    if (Test-Path -LiteralPath $StopRequestPath) { break }

    # Exit codes 3 and 4 mean a self-update is swapping bin/; wait for it as the
    # runner's run-helper.cmd does before relaunching.
    if ($code -eq 3 -or $code -eq 4) {
      $updateMarker = Join-Path $RunnerRoot 'update.finished'
      for ($second = 0; $second -lt 30; $second++) {
        if (Test-Path -LiteralPath $updateMarker) { Remove-Item -LiteralPath $updateMarker -Force; break }
        Start-Sleep -Seconds 1
      }
    }
    Restore-KitBinFiles
    # Restart=always with RestartSec=5, matching the systemd unit.
    Start-Sleep -Seconds 5
    if (Test-Path -LiteralPath $StopRequestPath) { break }
  }
  Write-SupervisorLog 'stopped on request'
  exit 0
} catch {
  Write-SupervisorLog "supervisor failed: $($_.Exception.Message)"
  exit 1
}
