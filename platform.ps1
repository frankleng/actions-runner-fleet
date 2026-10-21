# Shared Windows host-to-artifact mapping, the counterpart of platform.sh.
# Dot-source this file; do not execute it. Compatible with Windows PowerShell 5.1.
$RunnerVersion = if ($env:RUNNER_VERSION) { $env:RUNNER_VERSION } else { '2.336.0' }

$hostArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($hostArchitecture -ne 'AMD64') {
  throw "unsupported runner host: Windows $hostArchitecture; supported: macOS arm64, Linux x86_64, Windows x64"
}

$RunnerPlatform = 'win-x64'
$RunnerArchiveBasename = "actions-runner-win-x64-$RunnerVersion.zip"
$RunnerArchiveSha256 = 'd59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162'
$RunnerNodePlatform = 'win-x64'
$RunnerNodeArch = 'x64'
$RunnerPulumiPlatform = 'windows-x64'
$RunnerServiceManager = 'task-scheduler'
$RunnerArchiveUrl = "https://github.com/actions/runner/releases/download/v$RunnerVersion/$RunnerArchiveBasename"

# Task Scheduler, job object, and file helpers shared with each runner directory.
. (Join-Path $PSScriptRoot 'overlay\runner-common.ps1')

# Windows PowerShell 5.1 defaults to TLS 1.0 and a slow progress renderer.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

function Get-RunnerSha256([string]$Path) {
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Invoke-KitDownload([string]$Url, [string]$OutFile) {
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
}

function Add-KitText([string]$Path, [string]$Text) {
  [IO.File]::AppendAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

# The counterpart of chmod 700/600: only this user, SYSTEM, and Administrators.
$OwnerOnlySids = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')

# Replaces the whole access list, including explicit grants to anyone else, and
# stops inheritance. New files inherit it from an owner-only directory, so
# restrict directories before putting anything in them.
function Set-OwnerOnlyAcl([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer) {
    $security = New-Object Security.AccessControl.DirectorySecurity
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    $security = New-Object Security.AccessControl.FileSecurity
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
  }
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sid in $OwnerOnlySids) {
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule (
      (New-Object Security.Principal.SecurityIdentifier $sid), 'FullControl', $inheritance, 'None', 'Allow')))
  }
  # A fresh security object carries only the access list, so the owner is unchanged.
  $item.SetAccessControl($security)
  Assert-OwnerOnlyAcl $Path
}

function Assert-OwnerOnlyAcl([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  $others = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
    Where-Object { $OwnerOnlySids -notcontains $_.IdentityReference.Value })
  if (-not $acl.AreAccessRulesProtected -or $others.Count) { throw "access to $Path is not restricted to this user" }
}

# Task actions expand %VARIABLES% and cannot quote embedded double quotes.
function Assert-ServicePath([string]$Path) {
  if ($Path -notmatch '^[A-Za-z0-9_.:\\/@+ ()~-]+$') {
    throw 'Unsupported service path: use simple paths without quotes, percent signs, or other special characters'
  }
}

# Runner tasks run with a limited token, which never holds the symlink
# privilege, even for administrators. Developer Mode lets unelevated processes
# create symlinks; enabling it needs an administrator once per host.
function Test-DeveloperMode {
  $key = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -ErrorAction SilentlyContinue
  [bool]($key -and $key.AllowDevelopmentWithoutDevLicense -eq 1)
}

function Get-AvailableCpuCount {
  $count = [Environment]::ProcessorCount
  if ($count -lt 1) { throw 'could not determine the number of available logical CPUs' }
  $count
}

# Mirrors github_runner_scope_from_url in runner-target.sh; $null when invalid.
function Get-GitHubRunnerScope([string]$Url) {
  $url = $Url.TrimEnd('/')
  if ($url -cmatch '^https://github\.com/enterprises/[A-Za-z0-9_.-]+$') { return 'enterprise' }
  if ($url -cmatch '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { return 'repository' }
  if ($url -cmatch '^https://github\.com/[A-Za-z0-9_.-]+$') { return 'organization' }
  $null
}

function Expand-KitZip([string]$Archive, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
}
