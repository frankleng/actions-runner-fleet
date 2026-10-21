# Windows entry point, the counterpart of ./runnerctl. PowerShell resolves
# .\runnerctl to this file, so the same commands work on every host.
$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
. (Join-Path $ScriptDir 'platform.ps1')
$cliArgs = @($args)

if ($cliArgs.Count -and $cliArgs[0] -eq '--cli') {
  & $KitPowerShell @KitPowerShellArguments -File (Join-Path $ScriptDir 'manage-runners.ps1') @($cliArgs | Select-Object -Skip 1)
  exit $LASTEXITCODE
}

function Test-SupportedNode([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
  # No quotes inside: Windows PowerShell 5.1 strips them from native arguments.
  try { & $Path -e 'process.exit(parseInt(process.versions.node)>=24?0:1)' 2>$null | Out-Null } catch { return $false }
  $LASTEXITCODE -eq 0
}

# Background services keep using the node that enabled them, so prefer the
# kit's own copies over whatever happens to be on PATH.
$nodeBin = $env:RUNNERCTL_NODE_BIN
if ($nodeBin -and -not (Test-SupportedNode $nodeBin)) {
  [Console]::Error.WriteLine('RUNNERCTL_NODE_BIN must select Node.js 24 or newer')
  exit 1
}
if (-not $nodeBin) {
  $candidates = @(
    (Join-Path $ScriptDir 'host-tools\node-24.19.0-win-x64\node.exe'),
    (Join-Path $ScriptDir 'host-tools\node24\node.exe')
  )
  $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($pathNode) { $candidates += $pathNode.Source }
  $nodeBin = $candidates | Where-Object { Test-SupportedNode $_ } | Select-Object -First 1
}
if (-not $nodeBin) {
  $archivePath = if ($env:RUNNER_ARCHIVE_PATH) { $env:RUNNER_ARCHIVE_PATH } else { Join-Path $ScriptDir $RunnerArchiveBasename }
  if (-not (Test-Path -LiteralPath $archivePath)) {
    [Console]::Error.WriteLine("Node.js is unavailable and the bundled runner archive was not found: $archivePath")
    exit 1
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $nodeBin = Join-Path $ScriptDir 'host-tools\node24\node.exe'
  New-Item -ItemType Directory -Force -Path (Split-Path $nodeBin) | Out-Null
  $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $entry = $zip.Entries | Where-Object { $_.FullName -eq 'externals/node24/bin/node.exe' } | Select-Object -First 1
    if (-not $entry) { throw 'the runner archive has no externals/node24/bin/node.exe' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, "$nodeBin.tmp", $true)
    Move-Item -LiteralPath "$nodeBin.tmp" -Destination $nodeBin -Force
  } finally { $zip.Dispose() }
}

$app = Join-Path $ScriptDir 'runnerctl-app\bin'
$rest = @($cliArgs | Select-Object -Skip 1)
switch ($(if ($cliArgs.Count) { $cliArgs[0] } else { '' })) {
  'autoscale' { & $nodeBin (Join-Path $app 'runnerctl-autoscale.mjs') @rest }
  'health' { & $nodeBin (Join-Path $app 'runnerctl-health.mjs') @rest }
  'stats' { & $nodeBin (Join-Path $app 'runnerctl-stats.mjs') @rest }
  default { & $nodeBin (Join-Path $app 'runnerctl-dashboard.mjs') @cliArgs }
}
exit $LASTEXITCODE
