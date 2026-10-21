# Windows counterpart of runner-job-temp.sh, installed as
# job-hooks\runner-job-started.ps1 and job-hooks\runner-job-completed.ps1.
# Kept outside bin, which the runner replaces during automatic upgrades.
$ErrorActionPreference = 'Stop'
$runnerRoot = Split-Path -Parent $PSScriptRoot
$jobTemp = Join-Path $runnerRoot 'tmp\managed-job'

function Test-ReparsePoint([string]$Path) {
  (Test-Path -LiteralPath $Path) -and ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Invoke-PreviousHook([string]$Hook) {
  # Path aliases must never turn the wrapper into its own previous hook.
  if ([IO.Path]::GetFullPath($Hook) -ieq [IO.Path]::GetFullPath($PSCommandPath)) { return 0 }
  switch -Regex ($Hook) {
    '\.ps1$' {
      $shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
      & $shell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Hook | Out-Host
    }
    '\.(cmd|bat)$' { & cmd.exe /d /c $Hook | Out-Host }
    default {
      if (-not (Get-Command bash -ErrorAction SilentlyContinue)) {
        [Console]::Error.WriteLine("Cannot run previous hook ${Hook}: bash is required")
        return 1
      }
      & bash -e $Hook | Out-Host
    }
  }
  $LASTEXITCODE
}

function Clear-JobTemp {
  # Never traverse a redirected temporary root.
  if ((Test-ReparsePoint (Join-Path $runnerRoot 'tmp')) -or (Test-ReparsePoint $jobTemp)) {
    throw 'Refusing to clean a symlinked runner temporary directory'
  }
  New-Item -ItemType Directory -Force -Path $jobTemp | Out-Null
  $failed = $false
  foreach ($item in Get-ChildItem -LiteralPath $jobTemp -Force) {
    try {
      # rd removes junctions and symlinks without following them.
      if ($item.PSIsContainer) {
        & cmd.exe /d /c rd /s /q "`"$($item.FullName)`"" 2>$null
        if (Test-Path -LiteralPath $item.FullName) { $failed = $true }
      } else {
        Remove-Item -LiteralPath $item.FullName -Force
      }
    } catch { $failed = $true }
  }
  # Files held open by a leftover process cannot be removed. Report them
  # without failing every later job on this runner.
  if ($failed) { [Console]::Error.WriteLine("Warning: some runner scratch files could not be removed; check for running processes in $jobTemp") }
}

switch ([IO.Path]::GetFileName($PSCommandPath)) {
  'runner-job-started.ps1' {
    # Also removes leftovers from a cancelled job whose completion hook never ran.
    Clear-JobTemp
    if ($env:RUNNER_PREVIOUS_JOB_STARTED_HOOK) { exit (Invoke-PreviousHook $env:RUNNER_PREVIOUS_JOB_STARTED_HOOK) }
  }
  'runner-job-completed.ps1' {
    $hookStatus = 0
    if ($env:RUNNER_PREVIOUS_JOB_COMPLETED_HOOK) { $hookStatus = Invoke-PreviousHook $env:RUNNER_PREVIOUS_JOB_COMPLETED_HOOK }
    Clear-JobTemp
    exit $hookStatus
  }
  default {
    [Console]::Error.WriteLine('Invoke as runner-job-started.ps1 or runner-job-completed.ps1')
    exit 1
  }
}
