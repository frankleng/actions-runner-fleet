import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Kit scripts are bash on Linux and macOS and Windows PowerShell 5.1 on Windows.
export const WINDOWS_TASK_FOLDER = '\\actions-runner-fleet\\';
export const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

export function windowsPowerShell(env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Callers name the bash script; on Windows its PowerShell sibling runs instead.
// Anything other than a .sh file passes through unchanged.
export function scriptCommand(file, args = [], platform = process.platform, env = process.env) {
  if (platform !== 'win32' || !file.endsWith('.sh')) return { file, args };
  return { file: windowsPowerShell(env), args: [...POWERSHELL_ARGS, '-File', file.replace(/\.sh$/, '.ps1'), ...args] };
}

// kit-task.ps1 takes its program as base64 JSON; Windows PowerShell's -File
// mode would otherwise bind program options such as --config as its own.
export function kitTaskCommandLine(argv) {
  return Buffer.from(JSON.stringify(argv), 'utf8').toString('base64');
}

// Windows processes cannot start PowerShell or .NET without these.
export const WINDOWS_SERVICE_ENV_KEYS = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP',
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles',
  'ProgramFiles(x86)', 'CommonProgramFiles', 'PSModulePath', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'HOMEDRIVE', 'HOMEPATH'];

async function powershell(script, env = {}, timeout = 30000) {
  const { stdout } = await exec(windowsPowerShell(), [...POWERSHELL_ARGS, '-Command', script],
    { env: { ...process.env, ...env }, timeout, maxBuffer: 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

// Values travel in environment variables so paths never need PowerShell quoting.
export async function windowsTaskState(name) {
  try {
    return await powershell('$t = Get-ScheduledTask -TaskPath $env:RUNNER_TASK_PATH -TaskName $env:RUNNER_TASK_NAME -ErrorAction SilentlyContinue; if ($t) { [string]$t.State }',
      { RUNNER_TASK_PATH: WINDOWS_TASK_FOLDER, RUNNER_TASK_NAME: name }) || null;
  } catch { return null; }
}

export async function serviceActive(unit, platform = process.platform) {
  if (platform === 'win32') return await windowsTaskState(unit) === 'Running';
  try { return (await exec('systemctl', ['--user', 'is-active', unit])).stdout.trim() === 'active'; }
  catch { return false; }
}

// The Windows counterpart of "owned by this user with mode 0600": the owner is
// this user (or Administrators) and nobody beyond this user, SYSTEM, and
// Administrators is granted access.
export async function filePrivate(file, stat, platform = process.platform) {
  if (!stat.isFile()) return false;
  if (platform !== 'win32') return stat.uid === process.getuid?.() && !(stat.mode & 0o077);
  try {
    return await powershell(`$acl = Get-Acl -LiteralPath $env:RUNNER_PRIVATE_FILE
$sid = [Security.Principal.SecurityIdentifier]
$trusted = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
$others = @($acl.GetAccessRules($true, $true, $sid) | Where-Object { $_.AccessControlType -eq 'Allow' -and $trusted -notcontains $_.IdentityReference.Value })
if (@($trusted[0], 'S-1-5-32-544') -contains $acl.GetOwner($sid).Value -and $others.Count -eq 0) { 'private' }`,
    { RUNNER_PRIVATE_FILE: file }) === 'private';
  } catch { return false; }
}

// Windows has no load average (os.loadavg() is always zero). The busy fraction
// of all logical CPUs between polls serves the same role: 1.0 means saturated.
let previousCpuTimes;
export function windowsLoadPerCpu(cpus = os.cpus()) {
  const current = { busy: 0, total: 0 };
  for (const { times } of cpus) {
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    current.total += total;
    current.busy += total - times.idle;
  }
  // The first poll measures since boot; later polls measure the last interval.
  const previous = previousCpuTimes ?? { busy: 0, total: 0 };
  previousCpuTimes = current;
  const total = current.total - previous.total;
  return total > 0 ? Math.max(0, Math.min(1, (current.busy - previous.busy) / total)) : 0;
}
