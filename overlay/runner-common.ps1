# Windows service primitives shared by svc.ps1, runsvc.ps1, and the kit's
# platform.ps1. Dot-source it; it only defines functions and constants.
# Compatible with Windows PowerShell 5.1.

# Every kit task lives in one Task Scheduler folder so it is easy to audit.
$KitTaskFolder = '\actions-runner-fleet\'
$KitPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$KitPowerShellArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass')

# Files read by Node and by the runner must not start with a UTF-8 BOM, which
# Windows PowerShell 5.1 adds for -Encoding utf8. Replace by rename so readers
# never observe a partial file.
function Write-KitText([string]$Path, [string]$Text) {
  $temp = "$Path.tmp"
  [IO.File]::WriteAllText($temp, $Text, (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Read-KitText([string]$Path) {
  [IO.File]::ReadAllText($Path).TrimStart([char]0xFEFF)
}

# Add-Type recompiles on every call, which is too slow for status polling.
# Cache the assembly by source hash; a changed source gets a new file name, so
# a running supervisor never holds a stale file that needs replacing.
function Import-RunnerFleetNative([string]$Source, [string]$CacheDirectory) {
  if ('RunnerFleet.Native' -as [type]) { return }
  $hash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.Substring(0, 16)
  $assembly = Join-Path $CacheDirectory "RunnerFleetNative-$hash.dll"
  if (-not (Test-Path -LiteralPath $assembly)) {
    New-Item -ItemType Directory -Force -Path $CacheDirectory | Out-Null
    $temp = Join-Path $CacheDirectory "RunnerFleetNative-$hash.$PID.tmp"
    Add-Type -Path $Source -OutputAssembly $temp -OutputType Library
    try { Move-Item -LiteralPath $temp -Destination $assembly -ErrorAction Stop }
    catch { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  }
  Add-Type -Path $assembly
}

function Get-KitJobName([string]$Key) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Key.TrimEnd('\').ToLowerInvariant())
  $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  'Local\actions-runner-fleet.' + ([BitConverter]::ToString($digest).Replace('-', '').Substring(0, 16))
}

# A PID file can outlive its process and the PID can be reused. Trust it only
# while that process still runs the expected script.
function Get-OwnedProcessId([string]$PidFile, [string]$ScriptPath) {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  $id = 0
  if (-not [int]::TryParse((Read-KitText $PidFile).Trim(), [ref]$id) -or $id -lt 1) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
  if ($process -and $process.CommandLine -and
      $process.CommandLine.IndexOf($ScriptPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    return $id
  }
  $null
}

function Get-KitTaskState([string]$Name) {
  $task = Get-ScheduledTask -TaskPath $KitTaskFolder -TaskName $Name -ErrorAction SilentlyContinue
  if ($task) { [string]$task.State } else { $null }
}

# Registers a per-user task that runs a PowerShell script without a console
# window. S4U runs in session 0 without a desktop login or stored password.
# Registration requires elevation; HTTPS clients supply their own credentials.
function Register-KitTask {
  param(
    [string]$Name,
    [string]$Script,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory,
    [ValidateSet('Startup', 'Every5Minutes')][string]$Trigger = 'Startup',
    [string]$Description = ''
  )
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal $identity
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Installing headless runner tasks requires an elevated PowerShell. Run as administrator using the runner account.'
  }
  $commandLine = @($KitPowerShell) + $KitPowerShellArguments + @('-File', $Script) + $Arguments | ForEach-Object {
    if ($_ -match '"') { throw 'Task arguments must not contain double quotes' }
    if ($_ -match '[\s()]') { '"' + $_.TrimEnd('\') + '"' } else { $_ }
  }
  # conhost --headless gives the script a console without a window. Stopping the
  # task ends only conhost, so every kit script owns a kill-on-close job object.
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\conhost.exe') `
    -Argument ('--headless ' + ($commandLine -join ' ')) -WorkingDirectory $WorkingDirectory
  $user = $identity.Name
  if ($Trigger -eq 'Every5Minutes') {
    $taskTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  } else {
    $taskTrigger = New-ScheduledTaskTrigger -AtStartup
  }
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskPath $KitTaskFolder -TaskName $Name -Action $action -Trigger $taskTrigger `
    -Settings $settings -Principal $principal -Description $Description -Force | Out-Null
  Enable-ScheduledTask -TaskPath $KitTaskFolder -TaskName $Name | Out-Null
}

# Hard stop: ending the owning script closes its job handle, and the job's
# kill-on-close limit ends every process it started.
function Stop-KitTask([string]$Name, [string]$PidFile, [string]$ScriptPath) {
  $id = Get-OwnedProcessId $PidFile $ScriptPath
  if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  if (Get-KitTaskState $Name) { Stop-ScheduledTask -TaskPath $KitTaskFolder -TaskName $Name -ErrorAction SilentlyContinue }
}

function Unregister-KitTask([string]$Name, [string]$PidFile, [string]$ScriptPath) {
  Stop-KitTask $Name $PidFile $ScriptPath
  if (Get-KitTaskState $Name) { Unregister-ScheduledTask -TaskPath $KitTaskFolder -TaskName $Name -Confirm:$false }
}

# Whole-number percent, 100 = one logical CPU, capped at the host ceiling.
function Read-RunnerCpuQuota([string]$Path) {
  $max = [Environment]::ProcessorCount * 100
  $value = if ($env:RUNNER_DEFAULT_CPU_QUOTA_PERCENT) { $env:RUNNER_DEFAULT_CPU_QUOTA_PERCENT } else { [string][Math]::Floor($max * 50 / 100) }
  if (Test-Path -LiteralPath $Path) { $value = (Read-KitText $Path).Trim() }
  if ($value -notmatch '^\d+$') { throw "CPU quota must be a whole-number percent (received '$value')" }
  $quota = [long]$value
  if ($quota -lt 1) { throw 'CPU quota must be at least 1%' }
  if ($quota -gt $max) {
    [Console]::Error.WriteLine('Saved CPU quota exceeds current CPU capacity; using the host ceiling')
    $quota = $max
  }
  [int]$quota
}
