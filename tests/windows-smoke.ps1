# Windows end-to-end smoke test for the PowerShell layer. Runs a sandboxed
# copy of the kit with its own registry, a fake runner image, and tasks named
# for example-org, so it never touches real runners or contacts GitHub.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\windows-smoke.ps1
$ErrorActionPreference = 'Stop'
$KitSource = Split-Path -Parent $PSScriptRoot
$PowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Node = if ($env:RUNNERCTL_NODE_BIN) { $env:RUNNERCTL_NODE_BIN } else { (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $Node) { $Node = Join-Path $KitSource 'host-tools\node-24.19.0-win-x64\node.exe' }
if (-not (Test-Path -LiteralPath $Node)) { throw 'Node.js 24 is required: set RUNNERCTL_NODE_BIN' }

$Sandbox = Join-Path $env:TEMP "fleet-smoke-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$Kit = Join-Path $Sandbox 'kit'
$Failures = New-Object Collections.Generic.List[string]
$TaskNames = New-Object Collections.Generic.List[string]

function Assert-True([bool]$Condition, [string]$Message, [string]$Detail = '') {
  if ($Condition) { Write-Host "ok   $Message"; return }
  Write-Host "FAIL $Message"
  if ($Detail) { Write-Host $Detail }
  $Failures.Add($Message)
}

function Invoke-Kit([string]$Script, [string[]]$Arguments) {
  # Windows PowerShell 5.1 turns captured native stderr into errors; expected
  # failures are part of this test.
  $ErrorActionPreference = 'Continue'
  $output = & $PowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $Kit $Script) @Arguments 2>&1 | Out-String
  [pscustomobject]@{ Code = $LASTEXITCODE; Output = $output }
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds = 30) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) { if (& $Condition) { return $true }; Start-Sleep -Milliseconds 500 }
  [bool](& $Condition)
}

function Read-Text([string]$Path) {
  if (Test-Path -LiteralPath $Path) { [IO.File]::ReadAllText($Path) } else { '' }
}

# A stand-in Runner.Listener.exe. Ephemeral (JIT) mode proves the RSA key is
# DPAPI-readable and completes like a consumed registration; persistent mode
# can crash once on request and waits for Ctrl+C.
$FakeListenerSource = @'
using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

class FakeListener
{
    static int Main(string[] args)
    {
        string root = Directory.GetParent(AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\')).FullName;
        string log = Path.Combine(root, "fake-listener.log");
        File.AppendAllText(log, "start " + string.Join(" ", args) + "\n");
        string metadata = File.ReadAllText(Path.Combine(root, ".runner"));
        if (metadata.Contains("\"ephemeral\":true"))
        {
            byte[] key = ProtectedData.Unprotect(File.ReadAllBytes(Path.Combine(root, ".credentials_rsaparams")), null, DataProtectionScope.LocalMachine);
            File.AppendAllText(log, "rsa " + Encoding.UTF8.GetString(key) + "\n");
            foreach (string leaf in new[] { ".runner", ".credentials", ".credentials_rsaparams" }) File.Delete(Path.Combine(root, leaf));
            return 0;
        }
        string crashMarker = Path.Combine(root, "crash-once");
        if (File.Exists(crashMarker)) { File.Delete(crashMarker); File.AppendAllText(log, "crash\n"); return 2; }
        ManualResetEvent stop = new ManualResetEvent(false);
        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; File.AppendAllText(log, "ctrl-c\n"); stop.Set(); };
        stop.WaitOne();
        return 0;
    }
}
'@

try {
  Write-Host "sandbox: $Sandbox"
  New-Item -ItemType Directory -Path $Kit | Out-Null
  foreach ($item in 'overlay', 'runnerctl-app') {
    & robocopy.exe (Join-Path $KitSource $item) (Join-Path $Kit $item) /E /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
  }
  foreach ($leaf in 'platform.ps1', 'manage-runners.ps1', 'provision-runner-tooling.ps1', 'kit-task.ps1', 'runnerctl.ps1') {
    Copy-Item -LiteralPath (Join-Path $KitSource $leaf) -Destination $Kit
  }
  if (Test-Path -LiteralPath (Join-Path $KitSource 'runnerctl-app\node_modules')) {
    & cmd.exe /d /c mklink /J (Join-Path $Kit 'runnerctl-app\node_modules') (Join-Path $KitSource 'runnerctl-app\node_modules') | Out-Null
  }

  # Fake runner image, archive, config.cmd, and host tools: no downloads.
  $image = Join-Path $Sandbox 'image'
  New-Item -ItemType Directory -Force -Path (Join-Path $image 'bin'), (Join-Path $image 'externals\node24\bin') | Out-Null
  Copy-Item -LiteralPath $Node -Destination (Join-Path $image 'externals\node24\bin\node.exe')
  Add-Type -TypeDefinition $FakeListenerSource -ReferencedAssemblies System.Security -OutputAssembly (Join-Path $image 'bin\Runner.Listener.exe') -OutputType ConsoleApplication
  Set-Content -LiteralPath (Join-Path $image 'config.cmd') -Encoding ASCII -Value '@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fake-config.ps1" %*'
  Set-Content -LiteralPath (Join-Path $image 'fake-config.ps1') -Encoding ASCII -Value @'
$values = @{}
for ($i = 0; $i -lt $args.Count; $i++) { if ($args[$i] -like '--*' -and $i + 1 -lt $args.Count -and $args[$i + 1] -notlike '--*') { $values[$args[$i]] = $args[$i + 1]; $i++ } }
[IO.File]::WriteAllText("$PSScriptRoot\config-args.txt", ($args -join ' '))
$runner = '{"agentId":7,"agentName":"' + $values['--name'] + '","gitHubUrl":"' + $values['--url'] + '","workFolder":"_work"}'
[IO.File]::WriteAllText("$PSScriptRoot\.runner", $runner, (New-Object Text.UTF8Encoding $true))
'@
  $archive = Join-Path $Sandbox 'actions-runner-win-x64-fake.zip'
  Set-Content -LiteralPath $archive -Value 'unused: RUNNER_IMAGE_DIR is pre-extracted'
  $hostTools = Join-Path $Sandbox 'host-tools'
  New-Item -ItemType Directory -Force -Path (Join-Path $hostTools 'pnpm-tools\bin') | Out-Null
  Set-Content -LiteralPath (Join-Path $hostTools 'pnpm-tools\bin\wrangler.cmd') -Encoding ASCII -Value '@echo 0.0.0'
  $provisionStub = Join-Path $Sandbox 'provision-stub.ps1'
  Set-Content -LiteralPath $provisionStub -Value 'param([string]$Root) exit 0'

  $env:RUNNER_IMAGE_DIR = $image
  $env:RUNNER_ARCHIVE_PATH = $archive
  $env:RUNNER_HOST_TOOLS_DIR = $hostTools
  $env:RUNNER_PROVISION_SCRIPT_PATH = $provisionStub
  $env:RUNNER_STOP_GRACE_SECONDS = '20'
  $env:RUNNERCTL_NODE_BIN = $Node

  # --- registry, validation, and registration -----------------------------
  $result = Invoke-Kit 'manage-runners.ps1' @('list')
  Assert-True ($result.Code -eq 0 -and $result.Output -match 'no runners tracked') 'list on an empty registry'
  $result = Invoke-Kit 'manage-runners.ps1' @('register', 'smoke-bad', 'TOKEN', 'https://example.com/org')
  Assert-True ($result.Code -ne 0 -and $result.Output -match 'GitHub target must be') 'register rejects non-GitHub targets'
  $result = Invoke-Kit 'manage-runners.ps1' @('prepare-autoscale', 'smoke-slot', 'https://github.com/enterprises/acme')
  Assert-True ($result.Code -ne 0 -and $result.Output -match 'enterprise') 'autoscale rejects enterprise scope'

  $env:RUNNER_LABELS = 'smoke,windows-test'
  $result = Invoke-Kit 'manage-runners.ps1' @('register', 'smoke-persist', 'TOKEN-123', 'https://github.com/example-org')
  Remove-Item Env:\RUNNER_LABELS
  $persist = Join-Path $Kit '.runners\smoke-persist'
  $TaskNames.Add('actions.runner.example-org.smoke-persist')
  Assert-True ($result.Code -eq 0) 'register succeeds' $result.Output
  Assert-True ((Read-Text (Join-Path $persist 'config-args.txt')) -match '--unattended --url https://github.com/example-org --token TOKEN-123 --name smoke-persist --work _work --labels smoke,windows-test') 'config.cmd receives registration arguments and labels'
  Assert-True ((Read-Text (Join-Path $Kit 'runners.tsv')) -ceq "smoke-persist`t$persist`n") 'registry row is written without a BOM'
  $result = Invoke-Kit 'manage-runners.ps1' @('register', 'smoke-persist', 'TOKEN', 'https://github.com/example-org')
  Assert-True ($result.Code -ne 0 -and $result.Output -match 'already tracked') 'duplicate names are rejected'
  $trusted = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
  $grantees = @((Get-Acl -LiteralPath $persist).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value })
  Assert-True ($grantees.Count -gt 0 -and -not ($grantees | Where-Object { $trusted -notcontains $_ })) 'runner directory is owner-only'
  $childGrantees = @((Get-Acl -LiteralPath (Join-Path $persist 'bin\Runner.Listener.exe')).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value })
  Assert-True ($childGrantees.Count -gt 0 -and -not ($childGrantees | Where-Object { $trusted -notcontains $_ })) 'copied runner files inherit the owner-only access list'

  # A reused empty directory loses explicit grants to other accounts, and
  # reconcile refuses a directory that others can read.
  $shared = Join-Path $Sandbox 'shared-runner'
  New-Item -ItemType Directory -Path $shared | Out-Null
  & icacls.exe $shared /grant '*S-1-5-32-545:(OI)(CI)R' | Out-Null
  $env:RUNNER_DEFER_RECONCILE = '1'
  $result = Invoke-Kit 'manage-runners.ps1' @('register', 'smoke-shared', 'TOKEN', 'https://github.com/example-org', $shared)
  Remove-Item Env:\RUNNER_DEFER_RECONCILE
  $sharedGrantees = @((Get-Acl -LiteralPath $shared).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value })
  Assert-True ($result.Code -eq 0 -and $sharedGrantees -notcontains 'S-1-5-32-545') 'registration removes explicit grants from a reused directory' $result.Output
  & icacls.exe $shared /grant '*S-1-5-32-545:R' | Out-Null
  $result = Invoke-Kit 'manage-runners.ps1' @('reconcile', 'smoke-shared')
  Assert-True ($result.Code -ne 0 -and $result.Output -match 'not restricted') 'reconcile refuses a directory other users can read' $result.Output

  # A lone preserved .npmrc setting must stay on its own line.
  [IO.File]::WriteAllText((Join-Path $persist 'home\.npmrc'), "registry=https://example.invalid/`n")
  $result = Invoke-Kit 'manage-runners.ps1' @('reconcile', 'smoke-persist')
  $npmrc = (Read-Text (Join-Path $persist 'home\.npmrc')) -split "`n" | Where-Object { $_ }
  Assert-True ($result.Code -eq 0 -and $npmrc.Count -eq 3 -and $npmrc[0] -eq 'registry=https://example.invalid/' -and $npmrc[1] -like 'store-dir=*' -and $npmrc[2] -like 'cache=*') 'provisioning keeps a single custom .npmrc setting intact' ($npmrc -join "`n")

  foreach ($leaf in 'svc.ps1', 'runsvc.ps1', 'runner-common.ps1', 'RunnerFleetNative.cs', 'bin\autoscale-worker.mjs', 'job-hooks\runner-job-started.ps1', 'job-hooks\runner-job-completed.ps1', '.kit-root', '.service', '.env', '.path') {
    Assert-True (Test-Path -LiteralPath (Join-Path $persist $leaf)) "overlay installed $leaf"
  }
  Assert-True ((Read-Text (Join-Path $persist '.env')) -match "(?m)^ACTIONS_RUNNER_HOOK_JOB_STARTED=.*runner-job-started\.ps1`$") '.env points job hooks at the managed wrappers'
  $result = Invoke-Kit 'manage-runners.ps1' @('set-cpu-limit', 'smoke-persist', '0')
  Assert-True ($result.Code -ne 0) 'CPU quota below 1% is rejected'
  $result = Invoke-Kit 'manage-runners.ps1' @('set-cpu-limit', 'smoke-persist', [string]([Environment]::ProcessorCount * 100 + 1))
  Assert-True ($result.Code -ne 0) 'CPU quota above the host ceiling is rejected'

  # --- persistent runner service lifecycle --------------------------------
  Set-Content -LiteralPath (Join-Path $persist 'crash-once') -Value ''
  $result = Invoke-Kit 'manage-runners.ps1' @('start', 'smoke-persist')
  Assert-True ($result.Code -eq 0 -and $result.Output -match 'Started:') 'start reports Started' $result.Output
  $listenerLog = Join-Path $persist 'fake-listener.log'
  Assert-True (Wait-Until { ([regex]::Matches((Read-Text $listenerLog), 'start run --startuptype service')).Count -ge 2 } 30) 'supervisor restarts the listener after a retryable exit'
  Assert-True ((Read-Text $listenerLog) -match 'crash') 'first listener run crashed as arranged'
  $result = Invoke-Kit 'manage-runners.ps1' @('set-cpu-limit', 'smoke-persist', '150')
  Assert-True ($result.Code -eq 0) 'set-cpu-limit succeeds'
  Assert-True (Wait-Until { (Invoke-Kit 'manage-runners.ps1' @('status', 'smoke-persist')).Output -match 'Live CPU quota: 150 100' } 15) 'live job CPU cap follows set-cpu-limit'

  $statsJson = & $Node (Join-Path $Kit 'runnerctl-app\bin\runnerctl-stats.mjs') --json | Out-String
  $stats = ($statsJson | ConvertFrom-Json).runners | Where-Object { $_.name -eq 'smoke-persist' }
  Assert-True ($stats.status -eq 'running' -and $stats.metrics.processCount -ge 2 -and $stats.metrics.memoryBytes -gt 0) 'stats find the supervisor and listener processes'

  $stopWatch = [Diagnostics.Stopwatch]::StartNew()
  $result = Invoke-Kit 'manage-runners.ps1' @('stop', 'smoke-persist')
  $stopWatch.Stop()
  Assert-True ($result.Code -eq 0 -and $result.Output -match 'Stopped') 'stop reports Stopped' $result.Output
  Assert-True ((Read-Text $listenerLog) -match 'ctrl-c') 'stop delivers Ctrl+C to the listener'
  Assert-True ((Read-Text (Join-Path $persist '_diag\runsvc-supervisor.log')) -match 'sent Ctrl\+C to child') 'supervisor confirms Ctrl+C delivery'
  Assert-True ($stopWatch.Elapsed.TotalSeconds -lt 15) "graceful stop finishes before the grace deadline ($([int]$stopWatch.Elapsed.TotalSeconds)s)"
  Assert-True ((Read-Text (Join-Path $persist '_diag\runsvc-supervisor.log')) -match 'stopped on request') 'supervisor exits on the stop request'

  # --- autoscale slot: DPAPI-protected JIT handoff -------------------------
  $result = Invoke-Kit 'manage-runners.ps1' @('prepare-autoscale', 'smoke-slot', 'https://github.com/example-org')
  $slot = Join-Path $Kit '.runners\smoke-slot'
  $TaskNames.Add('actions.runner.example-org.smoke-slot')
  Assert-True ($result.Code -eq 0 -and (Test-Path -LiteralPath (Join-Path $slot '.autoscale-prepared'))) 'prepare-autoscale provisions a slot' $result.Output
  $slotIdentity = Read-Text (Join-Path $slot '.autoscale-slot.json') | ConvertFrom-Json
  Assert-True ($slotIdentity.agentName -eq 'smoke-slot' -and $slotIdentity.gitHubUrl -eq 'https://github.com/example-org' -and $slotIdentity.version -eq 1) 'slot identity matches the autoscaler format'
  $result = Invoke-Kit 'manage-runners.ps1' @('start', 'smoke-slot')
  $statePath = Join-Path $slot '.autoscale-state.json'
  Assert-True (Wait-Until { (Read-Text $statePath) -match '"phase":"ready"' } 30) 'slot worker parks ready without a registration'

  $rsaKey = '{"d":"smoke-private-key"}'
  $handoff = @{ '.runner' = '{"agentId":42,"agentName":"smoke-slot","gitHubUrl":"https://github.com/example-org","ephemeral":true,"workFolder":"_work"}'
    '.credentials' = '{"scheme":"OAuth"}'; '.credentials_rsaparams' = $rsaKey } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $slot '.autoscale-request.tmp'), $handoff)
  Move-Item -LiteralPath (Join-Path $slot '.autoscale-request.tmp') -Destination (Join-Path $slot '.autoscale-request.json')
  $slotLog = Join-Path $slot 'fake-listener.log'
  Assert-True (Wait-Until { (Read-Text $slotLog) -match 'rsa ' } 30) 'listener started for the handed-off generation'
  Assert-True ((Read-Text $slotLog).Contains("rsa $rsaKey")) 'RSA key is DPAPI-protected and readable by the listener'
  Assert-True (Wait-Until { -not (Test-Path -LiteralPath (Join-Path $slot '.autoscale-inflight.json')) -and (Read-Text $statePath) -match '"phase":"ready"' } 30) 'completed generation returns the slot to ready'
  $result = Invoke-Kit 'manage-runners.ps1' @('stop', 'smoke-slot')
  Assert-True ($result.Code -eq 0 -and $result.Output -match 'Stopped') 'slot stops cleanly'

  # --- job hooks -----------------------------------------------------------
  $jobTemp = Join-Path $persist 'tmp\managed-job'
  $outside = Join-Path $Sandbox 'outside'
  New-Item -ItemType Directory -Force -Path $jobTemp, (Join-Path $jobTemp 'nested'), $outside | Out-Null
  Set-Content -LiteralPath (Join-Path $jobTemp 'nested\leftover.txt') -Value 'x'
  Set-Content -LiteralPath (Join-Path $outside 'keep.txt') -Value 'x'
  & cmd.exe /d /c mklink /J (Join-Path $jobTemp 'link') $outside | Out-Null
  $previousHook = Join-Path $Sandbox 'previous-hook.ps1'
  Set-Content -LiteralPath $previousHook -Value "Set-Content -LiteralPath '$Sandbox\previous-ran.txt' -Value ran; exit 3"
  $env:RUNNER_PREVIOUS_JOB_COMPLETED_HOOK = $previousHook
  & $PowerShell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $persist 'job-hooks\runner-job-completed.ps1') | Out-Null
  $hookCode = $LASTEXITCODE
  Remove-Item Env:\RUNNER_PREVIOUS_JOB_COMPLETED_HOOK
  Assert-True ($hookCode -eq 3) 'completed hook returns the previous hook exit code'
  Assert-True (Test-Path -LiteralPath (Join-Path $Sandbox 'previous-ran.txt')) 'completed hook chains the previous hook'
  Assert-True (-not (Get-ChildItem -LiteralPath $jobTemp -Force)) 'completed hook empties the job temp directory'
  Assert-True (Test-Path -LiteralPath (Join-Path $outside 'keep.txt')) 'cleanup removes junctions without following them'

  # --- kit-level tasks (autoscale controller and health timer) -------------
  $taskName = "smoke-kit-task-$([Guid]::NewGuid().ToString('N').Substring(0, 6))"
  $TaskNames.Add($taskName)
  $argvFile = Join-Path $Sandbox 'argv.json'
  $probe = Join-Path $Sandbox 'probe.mjs'
  Set-Content -LiteralPath $probe -Value "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.SMOKE_ARGV ?? '$($argvFile.Replace('\', '\\'))', JSON.stringify(process.argv.slice(2))); console.log('probe started'); setInterval(() => {}, 1000);"
  $argv = @($Node, $probe, '--config', (Join-Path $Sandbox 'some config.json'), '--watch')
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $argv -Compress)))
  $taskLog = Join-Path $Sandbox 'task.log'
  $result = Invoke-Kit 'kit-task.ps1' @('install', '-Name', $taskName, '-Trigger', 'Logon', '-LogPath', $taskLog, '-CommandLine', $encoded)
  Assert-True ($result.Code -eq 0) 'kit-task install succeeds' $result.Output
  Assert-True (Wait-Until { Test-Path -LiteralPath $argvFile } 30) 'kit task starts its program'
  Assert-True ((Read-Text $argvFile) -eq (ConvertTo-Json -InputObject @($argv | Select-Object -Skip 2) -Compress)) 'program options such as --config arrive intact'
  Assert-True (Wait-Until { (Read-Text $taskLog) -match 'probe started' } 15) 'kit task appends program output to its log'
  Assert-True ((Invoke-Kit 'kit-task.ps1' @('state', '-Name', $taskName)).Output.Trim() -eq 'Running') 'kit-task state reports Running'
  $result = Invoke-Kit 'kit-task.ps1' @('remove', '-Name', $taskName)
  Assert-True (Wait-Until { -not (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($probe) }) } 15) 'removing a kit task ends its program through the job object'
  Assert-True ((Invoke-Kit 'kit-task.ps1' @('state', '-Name', $taskName)).Output.Trim() -eq 'missing') 'kit-task remove unregisters the task'

  # --- uninstall ------------------------------------------------------------
  foreach ($directory in $persist, $slot) {
    & $PowerShell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $directory 'svc.ps1') uninstall | Out-Null
    Assert-True ($LASTEXITCODE -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $directory '.service'))) "uninstall removes the service for $(Split-Path -Leaf $directory)"
  }
} finally {
  # Never leave sandbox tasks or processes behind, even after a failure.
  foreach ($name in $TaskNames) {
    if (Get-ScheduledTask -TaskPath '\actions-runner-fleet\' -TaskName $name -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskPath '\actions-runner-fleet\' -TaskName $name -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskPath '\actions-runner-fleet\' -TaskName $name -Confirm:$false
    }
  }
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Sandbox) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  foreach ($junction in (Join-Path $Kit 'runnerctl-app\node_modules')) {
    if (Test-Path -LiteralPath $junction) { & cmd.exe /d /c rmdir $junction | Out-Null }
  }
  & cmd.exe /d /c rd /s /q $Sandbox 2>$null
}

if ($Failures.Count) {
  Write-Host "$($Failures.Count) failure(s)"
  exit 1
}
Write-Host 'windows smoke test passed'
