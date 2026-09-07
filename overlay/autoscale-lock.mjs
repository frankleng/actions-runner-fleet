import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// The kernel releases ownership even after SIGKILL. No stale reaper, PID reuse,
// or unlink race. A port collision fails closed; this socket serves no protocol.
export async function acquireLock(directory, leaf) {
  const root = await fs.realpath(directory);
  const port = 20000 + createHash('sha256').update(`${root}/${leaf}`).digest().readUInt32BE(0) % 40000;
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  try {
    // Honor a running owner from installations using the previous file lock.
    let pid;
    try { pid = Number(await fs.readFile(path.join(root, leaf, 'pid'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pid !== undefined) {
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Unknown legacy owner');
      try { process.kill(pid, 0); throw new Error('Legacy owner alive'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await fs.rm(path.join(root, leaf), { force: true, recursive: true });
  } catch (error) { server.close(); throw error; }
  return () => new Promise(resolve => server.close(resolve));
}
