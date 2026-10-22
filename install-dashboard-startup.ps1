# Open the interactive dashboard when the current Windows user signs in.
$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
if (-not $startup) { throw 'The current user Startup folder is unavailable.' }
$shell = New-Object -ComObject WScript.Shell
$shortcutPath = Join-Path $startup 'Runner Fleet Dashboard.lnk'
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'runnerctl.ps1') + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = 'GitHub Actions runner fleet dashboard'
$shortcut.Save()
"Dashboard will open at sign-in: $shortcutPath"
