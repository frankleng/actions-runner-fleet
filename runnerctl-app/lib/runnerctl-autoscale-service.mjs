import { acquireLock } from '../../overlay/autoscale-lock.mjs';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export function controllerService({ root, configPath, node = process.execPath, home = os.homedir(), platform = process.platform, envPath = process.env.PATH || '/usr/bin:/bin' }) {
  const name = `runnerctl-autoscale-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
  const script = path.join(root, 'runnerctl-app/bin/runnerctl-autoscale.mjs');
  const args = [node, script, '--config', configPath, '--watch', '--apply'];
  // systemd expands specifiers even in quoted strings; never interpolate shell code.
  const quote = s => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
  const envQuote = s => quote(s).replaceAll('$$', '$');
  const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  if ([...args, home, envPath].some(v => /[\r\n\0]/.test(v))) throw new Error('Invalid service path');
  if (platform === 'linux') return {
    name: `${name}.service`, file: path.join(home, '.config/systemd/user', `${name}.service`),
    content: `[Unit]\nDescription=Runner fleet autoscaler\n\n[Service]\nType=simple\nExecStart=${args.map(quote).join(' ')}\nEnvironment=${envQuote(`HOME=${home}`)} ${envQuote(`PATH=${envPath}`)}\nRestart=on-failure\nRestartSec=15\nTimeoutStopSec=180\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`
  };
  if (platform === 'darwin') return {
    name, file: path.join(home, 'Library/LaunchAgents', `${name}.plist`),
    content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${args.map(s => `<string>${xml(s)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(envPath)}</string></dict><key>StandardOutPath</key><string>${xml(path.join(root, '.autoscale-controller.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(root, '.autoscale-controller.log'))}</string></dict></plist>\n`
  };
  throw new Error('Unsupported service platform');
}

export async function configureController(options, command, enable = true) {
  const unit = controllerService(options);
  if (!enable) {
    if (process.platform === 'linux') await command('systemctl', ['--user', 'disable', '--now', unit.name]);
    else {
      await command('launchctl', ['disable', `gui/${process.getuid()}/${unit.name}`]);
      await command('launchctl', ['bootout', `gui/${process.getuid()}/${unit.name}`]).catch(() => {});
    }
    return;
  }
  await fs.mkdir(path.dirname(unit.file), { recursive: true });
  await fs.writeFile(`${unit.file}.tmp`, unit.content, { mode: 0o600 });
  await fs.rename(`${unit.file}.tmp`, unit.file);
  if (process.platform === 'linux') {
    await command('systemctl', ['--user', 'daemon-reload']);
    await command('systemctl', ['--user', 'enable', unit.name]);
    await command('systemctl', ['--user', 'restart', unit.name]);
  } else {
    const domain = `gui/${process.getuid()}`;
    await command('launchctl', ['enable', `${domain}/${unit.name}`]);
    await command('launchctl', ['bootout', `${domain}/${unit.name}`]).catch(() => {});
    await command('launchctl', ['bootstrap', domain, unit.file]);
  }
}

export async function acquireControllerLock(root) {
  return acquireLock(root, '.autoscale.lock');
}

// Truncate the same inode: launchd retains an open descriptor to this path.
export async function boundControllerLog(root) {
  if (process.platform !== 'darwin') return;
  const file = path.join(root, '.autoscale-controller.log');
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.size <= 1024 * 1024) return;
  await fs.truncate(file, 0);
  await fs.chmod(file, 0o600);
}
