# Kit-level scheduled tasks for the autoscale controller and the health check:
# the Windows counterpart of their systemd user units and launchd agents.
#   install -Name N [-Trigger Logon|Every5Minutes] [-LogPath FILE] -CommandLine BASE64
#   remove -Name N | state -Name N
# CommandLine is base64-encoded JSON (program first): Windows PowerShell's -File
# mode would otherwise bind program options such as --config as its own.
param(
  [Parameter(Mandatory = $true, Position = 0)][ValidateSet('install', 'remove', 'state', 'run')][string]$Command,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Name,
  [ValidateSet('Logon', 'Every5Minutes')][string]$Trigger = 'Logon',
  [string]$LogPath = '',
  [ValidatePattern('^[A-Za-z0-9+/=]*$')][string]$CommandLine = ''
)
$ErrorActionPreference = 'Stop'
$KitRoot = $PSScriptRoot
. (Join-Path $KitRoot 'platform.ps1')
$PidFile = Join-Path $KitRoot ".task-$Name.pid"
$program = @()
if ($CommandLine) {
  # Windows PowerShell 5.1 emits a JSON array as one object; unroll it.
  $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CommandLine)) | ConvertFrom-Json
  $program = @($decoded | ForEach-Object { [string]$_ })
}

switch ($Command) {
  'install' {
    if (-not $program.Count -or -not (Test-Path -LiteralPath $program[0] -PathType Leaf)) { throw 'install needs an existing program to run' }
    $program + @($LogPath, $KitRoot) | Where-Object { $_ -and $_ -match '^[A-Za-z]:\\' } | ForEach-Object { Assert-ServicePath $_ }
    $runArguments = @('run', '-Name', $Name, '-CommandLine', $CommandLine)
    if ($LogPath) { $runArguments += @('-LogPath', $LogPath) }
    Register-KitTask -Name $Name -Script $PSCommandPath -Arguments $runArguments `
      -WorkingDirectory $KitRoot -Trigger $Trigger -Description "actions-runner-fleet ($KitRoot)"
    if ($Trigger -eq 'Logon') {
      # Restart a running controller so it picks up the new definition.
      Stop-KitTask $Name $PidFile $PSCommandPath
      Start-ScheduledTask -TaskPath $KitTaskFolder -TaskName $Name
    }
  }
  'remove' { Unregister-KitTask $Name $PidFile $PSCommandPath }
  'state' { $state = Get-KitTaskState $Name; if ($state) { $state } else { 'missing' } }
  'run' {
    if (-not $program.Count -or -not (Test-Path -LiteralPath $program[0] -PathType Leaf)) { throw 'the task program is missing' }
    Import-RunnerFleetNative (Join-Path $KitRoot 'overlay\RunnerFleetNative.cs') (Join-Path $KitRoot 'host-tools\native')
    # The job ends the program too when this wrapper is stopped or killed.
    $job = [RunnerFleet.Native]::CreateSupervisorJob((Get-KitJobName "$KitRoot\task\$Name"))
    Write-KitText $PidFile "$PID`n"
    # Native stderr arrives as error records; keep logging instead of stopping.
    $ErrorActionPreference = 'Continue'
    $programArguments = @($program | Select-Object -Skip 1)
    if ($LogPath) {
      & $program[0] @programArguments 2>&1 | ForEach-Object { [IO.File]::AppendAllText($LogPath, "$_`r`n") }
    } else {
      & $program[0] @programArguments 2>&1 | Out-Null
    }
    exit $LASTEXITCODE
  }
}
