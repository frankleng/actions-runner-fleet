import { createHash } from 'node:crypto';
import path from 'node:path';

// Organization containers (docs/org-containers.md): each GitHub organization's
// autoscaler and slots run in one long-lived container with its own network
// namespace, Docker daemon, systemd, and CPU/memory limits. This module is
// pure: it validates org-containers.json and renders the exact docker
// arguments, so every command can be previewed before anything changes.

export class OrgConfigError extends Error {}
const fail = message => { throw new OrgConfigError(`org-containers.json: ${message}`); };

export const KIT_DIR = '/runner/kit';
export const RUNNER_HOME = '/home/runner';
export const IMAGE_REPOSITORY = 'actions-runner-fleet-org';
export const LABEL = 'io.github.actions-runner-fleet';
// The inner daemon's own ranges (container/daemon.json); org bridges must not overlap them.
export const INNER_RANGES = ['10.200.0.0/15'];
// The host daemon's default bridge.
export const HOST_DOCKER_DEFAULT = '172.17.0.0/16';
// Devices a job may plausibly need; anything else (disks, GPUs, consoles) is refused.
export const ALLOWED_DEVICES = ['/dev/kvm', '/dev/fuse', '/dev/net/tun'];
export const RUNTIMES = ['sysbox-runc', 'privileged'];
// The container files the image is built from; their content is part of its tag.
export const IMAGE_FILES = ['Dockerfile', 'daemon.json', 'journald.conf', 'user-delegate.conf', 'runner-org-status'];

const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const PACKAGE = /^[a-z0-9][a-z0-9+.-]{0,99}$/;
const IMAGE_REF = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/;
const IFNAME = /^[a-z0-9][a-z0-9_.-]{0,14}$/;
const NETWORK_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}
const intToIp = n => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');

export function parseCidr(text) {
  const match = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(String(text));
  if (!match) return null;
  const base = ipToInt(match[1]);
  const prefix = Number(match[2]);
  if (base === null || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  if (base % size !== 0) return null;
  return { base, prefix, size, text: `${match[1]}/${prefix}` };
}
export const cidrsOverlap = (a, b) => a.base < b.base + b.size && b.base < a.base + a.size;

// "24g", "512m", or a byte count, to bytes.
export function parseBytes(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  const match = /^(\d+)([kmg])?$/i.exec(String(value ?? ''));
  if (!match) return null;
  const bytes = Number(match[1]) * 1024 ** ({ k: 1, m: 2, g: 3 }[match[2]?.toLowerCase()] ?? 0);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

const ORG_KEYS = new Set(['uid', 'runtime', 'allowPrivileged', 'cpus', 'cpusetCpus', 'memory', 'memorySwap', 'pidsLimit', 'shmSize',
  'network', 'devices', 'aptPackages', 'baseImage', 'hostname', 'disableIpv6', 'stopTimeoutSeconds']);

export function validateOrgConfig(raw, { hostname = 'host' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('expected an object');
  if (Object.keys(raw).some(k => !['dataRoot', 'orgs'].includes(k))) fail('unknown top-level key');
  const dataRoot = raw.dataRoot ?? '/srv/data/runner-orgs';
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || path.normalize(dataRoot) !== dataRoot || dataRoot === '/' ||
      /[\0\n,:]/.test(dataRoot)) fail('dataRoot must be a normalized absolute path without commas or colons');
  if (!raw.orgs || typeof raw.orgs !== 'object' || Array.isArray(raw.orgs) || !Object.keys(raw.orgs).length) fail('orgs must list at least one organization');

  const orgs = {};
  const seen = { uid: new Map(), bridge: new Map(), network: new Map(), lower: new Map(), subnets: [] };
  const shortHost = String(hostname).split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'host';
  for (const [org, entry] of Object.entries(raw.orgs)) {
    if (!ORG.test(org)) fail(`"${org}" is not a GitHub organization name`);
    const id = org.toLowerCase();
    if (seen.lower.has(id)) fail(`"${org}" is listed twice`);
    seen.lower.set(id, org);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${org}: expected an object`);
    const unknown = Object.keys(entry).find(k => !ORG_KEYS.has(k));
    if (unknown) fail(`${org}: unknown key "${unknown}"`);

    // A fixed, unused UID per org: host files in its data directory belong to
    // it, so no host login (and no other org) owns them.
    if (!Number.isSafeInteger(entry.uid) || entry.uid < 2000 || entry.uid > 59999) fail(`${org}: uid must be an unused integer from 2000 to 59999`);
    if (seen.uid.has(entry.uid)) fail(`${org}: uid ${entry.uid} is also used by ${seen.uid.get(entry.uid)}`);
    seen.uid.set(entry.uid, org);

    const runtime = entry.runtime ?? 'sysbox-runc';
    if (!RUNTIMES.includes(runtime)) fail(`${org}: runtime must be one of ${RUNTIMES.join(', ')}`);
    if (runtime === 'privileged' && entry.allowPrivileged !== true) fail(`${org}: the privileged runtime makes container root host root; set "allowPrivileged": true to accept that`);
    if (entry.allowPrivileged !== undefined && typeof entry.allowPrivileged !== 'boolean') fail(`${org}: allowPrivileged must be a boolean`);

    if (typeof entry.cpus !== 'number' || !Number.isFinite(entry.cpus) || entry.cpus <= 0 || entry.cpus > 1024 ||
        Math.round(entry.cpus * 100) !== entry.cpus * 100) fail(`${org}: cpus must be a positive number with at most two decimals`);
    if (entry.cpusetCpus !== undefined && entry.cpusetCpus !== null && !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(String(entry.cpusetCpus))) fail(`${org}: cpusetCpus must look like "0-7" or "0,2,4"`);
    const memory = parseBytes(entry.memory);
    if (!memory || memory < 2 * 1024 ** 3) fail(`${org}: memory must be at least 2g`);
    const memorySwap = entry.memorySwap === undefined ? memory : parseBytes(entry.memorySwap);
    if (!memorySwap || memorySwap < memory) fail(`${org}: memorySwap must be at least memory (equal means no swap)`);
    const shm = parseBytes(entry.shmSize ?? '2g');
    if (!shm || shm < 64 * 1024 ** 2 || shm > memory) fail(`${org}: shmSize must be between 64m and memory`);
    const pidsLimit = entry.pidsLimit ?? 32768;
    if (!Number.isSafeInteger(pidsLimit) || pidsLimit < 1024) fail(`${org}: pidsLimit must be an integer of at least 1024`);
    const stopTimeoutSeconds = entry.stopTimeoutSeconds ?? 120;
    if (!Number.isSafeInteger(stopTimeoutSeconds) || stopTimeoutSeconds < 30 || stopTimeoutSeconds > 3600) fail(`${org}: stopTimeoutSeconds must be 30 to 3600`);

    const devices = entry.devices ?? [];
    if (!Array.isArray(devices) || devices.some(d => !ALLOWED_DEVICES.includes(d)) || new Set(devices).size !== devices.length) {
      fail(`${org}: devices may only list ${ALLOWED_DEVICES.join(', ')}`);
    }
    const aptPackages = entry.aptPackages ?? [];
    if (!Array.isArray(aptPackages) || aptPackages.some(p => typeof p !== 'string' || !PACKAGE.test(p))) fail(`${org}: aptPackages must be Debian package names`);
    const baseImage = entry.baseImage ?? 'ubuntu:26.04';
    if (typeof baseImage !== 'string' || !IMAGE_REF.test(baseImage)) fail(`${org}: baseImage must be an image reference`);
    const host = entry.hostname ?? `${shortHost}-${id}`.slice(0, 63).replace(/-+$/, '');
    if (typeof host !== 'string' || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) fail(`${org}: hostname must be a lowercase DNS label`);
    if (entry.disableIpv6 !== undefined && typeof entry.disableIpv6 !== 'boolean') fail(`${org}: disableIpv6 must be a boolean`);

    // One bridge per org, created once with a fixed subnet: the only host
    // network change this org ever causes is at its own setup.
    const net = entry.network;
    if (!net || typeof net !== 'object' || Array.isArray(net) || Object.keys(net).some(k => !['name', 'bridge', 'subnet'].includes(k))) {
      fail(`${org}: network must be an object with subnet and optional name and bridge`);
    }
    const subnet = parseCidr(net.subnet);
    if (!subnet || subnet.prefix < 16 || subnet.prefix > 29) fail(`${org}: network.subnet must be an aligned IPv4 CIDR from /16 to /29`);
    for (const reserved of [...INNER_RANGES, HOST_DOCKER_DEFAULT]) {
      if (cidrsOverlap(subnet, parseCidr(reserved))) fail(`${org}: network.subnet overlaps ${reserved}, which Docker already uses`);
    }
    const clash = seen.subnets.find(s => cidrsOverlap(s.subnet, subnet));
    if (clash) fail(`${org}: network.subnet overlaps ${clash.org}`);
    seen.subnets.push({ org, subnet });
    const networkName = net.name ?? `runner-org-${id}`;
    const bridge = net.bridge ?? `rf-${id}`.slice(0, 15).replace(/[-_.]+$/, '');
    if (typeof networkName !== 'string' || !NETWORK_NAME.test(networkName)) fail(`${org}: network.name is not a valid Docker network name`);
    if (typeof bridge !== 'string' || !IFNAME.test(bridge)) fail(`${org}: network.bridge must be a Linux interface name of at most 15 characters`);
    for (const [key, value] of [['bridge', bridge], ['network', networkName]]) {
      if (seen[key].has(value)) fail(`${org}: network ${key} "${value}" is also used by ${seen[key].get(value)}`);
      seen[key].set(value, org);
    }

    const dir = path.join(dataRoot, id);
    orgs[org] = {
      org, id, uid: entry.uid, runtime, cpus: entry.cpus, cpusetCpus: entry.cpusetCpus ?? null, memory, memorySwap, shmSize: shm, pidsLimit,
      stopTimeoutSeconds, devices, aptPackages, baseImage, hostname: host, disableIpv6: entry.disableIpv6 ?? true,
      container: `runner-org-${id}`,
      network: { name: networkName, bridge, subnet: subnet.text, gateway: intToIp(subnet.base + 1), address: intToIp(subnet.base + 2) },
      paths: { root: dir, kit: path.join(dir, 'kit'), home: path.join(dir, 'home'), docker: path.join(dir, 'docker'), tmp: path.join(dir, 'tmp') }
    };
  }
  return { dataRoot, orgs };
}

export function selectOrg(config, name) {
  const org = Object.values(config.orgs).find(o => o.org === name || o.id === String(name).toLowerCase());
  if (!org) throw new OrgConfigError(`Organization "${name}" is not in org-containers.json`);
  return org;
}

export function buildArgs(o) {
  return { BASE_IMAGE: o.baseImage, RUNNER_UID: String(o.uid), RUNNER_SUDO: o.runtime === 'privileged' ? '0' : '1',
    EXTRA_APT_PACKAGES: [...o.aptPackages].sort().join(' ') };
}

// The tag names the image's whole input: the container files and build
// arguments. A changed Dockerfile or package list is a new tag, which is how
// status sees that an org needs an upgrade.
export function imageTag(o, files) {
  const hash = createHash('sha256');
  for (const name of IMAGE_FILES) {
    if (typeof files[name] !== 'string' && !Buffer.isBuffer(files[name])) throw new OrgConfigError(`container/${name} is missing`);
    hash.update(`${name}\0`).update(files[name]).update('\0');
  }
  hash.update(JSON.stringify(buildArgs(o)));
  return `${IMAGE_REPOSITORY}:${o.id}-${hash.digest('hex').slice(0, 12)}`;
}

export function dockerBuildArgs(o, contextDir, tag) {
  const args = ['build', '--pull', '--file', path.join(contextDir, 'Dockerfile'), '--tag', tag,
    '--label', `${LABEL}.org=${o.org}`];
  for (const [key, value] of Object.entries(buildArgs(o))) args.push('--build-arg', `${key}=${value}`);
  args.push(contextDir);
  return args;
}

export function networkCreateArgs(o) {
  return ['network', 'create', '--driver', 'bridge', '--subnet', o.network.subnet, '--gateway', o.network.gateway,
    '--opt', `com.docker.network.bridge.name=${o.network.bridge}`,
    // One container per network; nothing else may talk to it across the bridge.
    '--opt', 'com.docker.network.bridge.enable_icc=false',
    '--label', `${LABEL}.org=${o.org}`, o.network.name];
}

// What the container's settings hash covers: everything create decides.
export function configHash(o, image) {
  return createHash('sha256').update(JSON.stringify({ ...o, image })).digest('hex').slice(0, 12);
}

const bind = (source, target) => ['--mount', `type=bind,source=${source},target=${target}`];

export function containerCreateArgs(o, image) {
  const args = ['create', '--name', o.container, '--hostname', o.hostname,
    '--label', `${LABEL}.org=${o.org}`, '--label', `${LABEL}.config=${configHash(o, image)}`,
    '--restart', 'unless-stopped', '--stop-timeout', String(o.stopTimeoutSeconds), '--cgroupns', 'private'];
  if (o.runtime === 'sysbox-runc') args.push('--runtime', 'sysbox-runc');
  // The fallback: plain runc with every privilege. Root inside is host root.
  else args.push('--privileged');
  args.push('--network', o.network.name, '--ip', o.network.address);
  if (o.disableIpv6) args.push('--sysctl', 'net.ipv6.conf.all.disable_ipv6=1', '--sysctl', 'net.ipv6.conf.default.disable_ipv6=1');
  args.push('--cpus', String(o.cpus));
  if (o.cpusetCpus) args.push('--cpuset-cpus', o.cpusetCpus);
  args.push('--memory', String(o.memory), '--memory-swap', String(o.memorySwap), '--pids-limit', String(o.pidsLimit),
    '--shm-size', String(o.shmSize), '--ulimit', 'nofile=1048576:1048576');
  for (const device of o.devices) args.push('--device', device);
  // Only this org's directories; never the host Docker socket, home, or kit.
  args.push(...bind(o.paths.kit, KIT_DIR), ...bind(o.paths.home, RUNNER_HOME),
    ...bind(o.paths.docker, '/var/lib/docker'), ...bind(o.paths.tmp, '/tmp'));
  // No -e/--env-file: the container starts with the image's minimal environment only.
  args.push(image);
  return args;
}

// docker exec as the runner, with only what its user manager needs. stdin
// passes through (tokens are piped in, never put on a command line).
export function execArgs(o, command, { stdin = false, tty = false } = {}) {
  return ['exec', ...(stdin ? ['--interactive'] : []), ...(tty ? ['--tty'] : []), '--user', 'runner', '--workdir', KIT_DIR,
    '--env', `XDG_RUNTIME_DIR=/run/user/${o.uid}`, '--env', `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${o.uid}/bus`,
    o.container, ...command];
}

const sh = s => `'${String(s).replaceAll("'", "'\\''")}'`;

// The one-time host steps that need root, as a script to review and run with
// sudo. Nothing here touches existing runners, networks, or services.
export function setupScript(config, o, { source, originUrl }) {
  const lines = [
    '#!/bin/bash',
    `# One-time root setup for the ${o.org} organization container. Review, then run with sudo.`,
    'set -euo pipefail',
    `if getent passwd ${o.uid} >/dev/null || getent group ${o.uid} >/dev/null; then echo 'UID ${o.uid} belongs to a host account; choose another uid' >&2; exit 1; fi`,
    '# Only root can enter the data root, so no host login reaches org files, tokens, or setuid',
    '# files written by container root.',
    `install -d -o root -g root -m 0711 ${sh(config.dataRoot)}`,
    `install -d -o ${o.uid} -g ${o.uid} -m 0700 ${sh(o.paths.root)} ${sh(o.paths.home)}`,
    `install -d -o root -g root -m 0700 ${sh(o.paths.docker)}`,
    `install -d -o root -g root -m 1777 ${sh(o.paths.tmp)}`,
    `if [ ! -e ${sh(o.paths.kit)} ]; then`,
    `  git -c safe.directory=${sh(source)} -c safe.directory=${sh(path.join(source, '.git'))} clone --quiet --no-local ${sh(source)} ${sh(o.paths.kit)}`,
    ...(originUrl ? [`  git -C ${sh(o.paths.kit)} remote set-url origin ${sh(originUrl)}`] : []),
    `  chown -R ${o.uid}:${o.uid} ${sh(o.paths.kit)}`,
    'fi',
    `echo 'Data directories for ${o.org} are ready under ${o.paths.root}'`
  ];
  return lines.join('\n') + '\n';
}
