import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateOrgConfig, selectOrg, containerCreateArgs, networkCreateArgs, dockerBuildArgs, execArgs, imageTag, setupScript,
  parseCidr, parseBytes, OrgConfigError, IMAGE_FILES, KIT_DIR } from '../lib/runnerctl-org-container.mjs';

const GiB = 1024 ** 3;
const base = (orgs = {}) => ({
  dataRoot: '/srv/data/runner-orgs',
  orgs: { edgefleetinc: { uid: 2101, cpus: 8, memory: '24g', network: { subnet: '10.231.1.0/29' } }, ...orgs }
});
const files = Object.fromEntries(IMAGE_FILES.map(n => [n, `contents of ${n}`]));
const flag = (args, name) => args.flatMap((a, i) => a === name ? [args[i + 1]] : []);

test('a minimal org gets safe defaults and derived names', () => {
  const o = selectOrg(validateOrgConfig(base(), { hostname: 'littlebeast.lan' }), 'edgefleetinc');
  assert.equal(o.runtime, 'sysbox-runc');
  assert.equal(o.container, 'runner-org-edgefleetinc');
  assert.equal(o.hostname, 'littlebeast-edgefleetinc');
  assert.equal(o.memory, 24 * GiB);
  assert.equal(o.memorySwap, 24 * GiB, 'no swap unless asked');
  assert.equal(o.shmSize, 2 * GiB, 'Chromium needs more than the 64 MiB default');
  assert.equal(o.disableIpv6, true);
  assert.deepEqual(o.network, { name: 'runner-org-edgefleetinc', bridge: 'rf-edgefleetinc', subnet: '10.231.1.0/29',
    gateway: '10.231.1.1', address: '10.231.1.2' });
  assert.deepEqual(o.paths, { root: '/srv/data/runner-orgs/edgefleetinc', kit: '/srv/data/runner-orgs/edgefleetinc/kit',
    home: '/srv/data/runner-orgs/edgefleetinc/home', docker: '/srv/data/runner-orgs/edgefleetinc/docker', tmp: '/srv/data/runner-orgs/edgefleetinc/tmp' });
  // Lookup is case-insensitive like GitHub logins.
  assert.equal(selectOrg(validateOrgConfig(base()), 'EdgeFleetInc').org, 'edgefleetinc');
  assert.throws(() => selectOrg(validateOrgConfig(base()), 'titledock'), OrgConfigError);
});

test('the container never inherits the host: no env, socket, home, or host network', () => {
  const o = selectOrg(validateOrgConfig(base()), 'edgefleetinc');
  const args = containerCreateArgs(o, 'actions-runner-fleet-org:edgefleetinc-abc');
  assert.equal(args[0], 'create');
  assert.equal(args.at(-1), 'actions-runner-fleet-org:edgefleetinc-abc');
  for (const forbidden of ['-e', '--env', '--env-file', '--privileged', '--pid', '--ipc', '--userns', '-v', '--volume', '--volumes-from']) {
    assert.ok(!args.includes(forbidden), `${forbidden} must not appear`);
  }
  assert.ok(!args.some(a => /docker\.sock|source=\/home\/|source=\/root\b|^host$/.test(a)), 'no host socket, home, or host mode');
  assert.deepEqual(flag(args, '--runtime'), ['sysbox-runc']);
  assert.deepEqual(flag(args, '--network'), ['runner-org-edgefleetinc']);
  assert.deepEqual(flag(args, '--ip'), ['10.231.1.2']);
  assert.deepEqual(flag(args, '--cpus'), ['8']);
  assert.deepEqual(flag(args, '--memory'), [String(24 * GiB)]);
  assert.deepEqual(flag(args, '--memory-swap'), [String(24 * GiB)]);
  assert.deepEqual(flag(args, '--restart'), ['unless-stopped']);
  assert.deepEqual(flag(args, '--cgroupns'), ['private']);
  assert.deepEqual(flag(args, '--sysctl'), ['net.ipv6.conf.all.disable_ipv6=1', 'net.ipv6.conf.default.disable_ipv6=1']);
  // Exactly the org's own four directories.
  assert.deepEqual(flag(args, '--mount'), [
    'type=bind,source=/srv/data/runner-orgs/edgefleetinc/kit,target=/runner/kit',
    'type=bind,source=/srv/data/runner-orgs/edgefleetinc/home,target=/home/runner',
    'type=bind,source=/srv/data/runner-orgs/edgefleetinc/docker,target=/var/lib/docker',
    'type=bind,source=/srv/data/runner-orgs/edgefleetinc/tmp,target=/tmp']);
  assert.equal(flag(args, '--device').length, 0);
  assert.match(flag(args, '--label').join(' '), /\.org=edgefleetinc .*\.config=[0-9a-f]{12}$/);
});

test('one bridge per org, created once, with no inter-container traffic', () => {
  const o = selectOrg(validateOrgConfig(base()), 'edgefleetinc');
  assert.deepEqual(networkCreateArgs(o), ['network', 'create', '--driver', 'bridge', '--subnet', '10.231.1.0/29', '--gateway', '10.231.1.1',
    '--opt', 'com.docker.network.bridge.name=rf-edgefleetinc', '--opt', 'com.docker.network.bridge.enable_icc=false',
    '--label', 'io.github.actions-runner-fleet.org=edgefleetinc', 'runner-org-edgefleetinc']);
});

test('networks may not overlap each other or the Docker ranges', () => {
  const second = sub => base({ titledock: { uid: 2103, cpus: 12, memory: '32g', network: { subnet: sub } } });
  assert.doesNotThrow(() => validateOrgConfig(second('10.231.3.0/29')));
  assert.throws(() => validateOrgConfig(second('10.231.1.0/28')), /overlaps edgefleetinc/);
  assert.throws(() => validateOrgConfig(second('10.200.5.0/24')), /overlaps 10\.200\.0\.0\/15/);
  assert.throws(() => validateOrgConfig(second('172.17.4.0/24')), /overlaps 172\.17\.0\.0\/16/);
  assert.throws(() => validateOrgConfig(second('10.231.3.1/29')), /aligned/);
  assert.throws(() => validateOrgConfig(second('10.231.3.0/30')), /aligned IPv4 CIDR/);
  const sameBridge = base({ titledock: { uid: 2103, cpus: 1, memory: '4g', network: { subnet: '10.231.3.0/29', bridge: 'rf-edgefleetinc' } } });
  assert.throws(() => validateOrgConfig(sameBridge), /bridge "rf-edgefleetinc" is also used/);
  assert.throws(() => validateOrgConfig(base({ titledock: { uid: 2103, cpus: 1, memory: '4g', network: { subnet: '10.231.3.0/29', bridge: 'this-name-is-too-long' } } })), /15 characters/);
});

test('uids are per org and never a host login range', () => {
  assert.throws(() => validateOrgConfig(base({ titledock: { uid: 2101, cpus: 1, memory: '4g', network: { subnet: '10.231.3.0/29' } } })), /also used by edgefleetinc/);
  assert.throws(() => validateOrgConfig({ orgs: { a: { uid: 1000, cpus: 1, memory: '4g', network: { subnet: '10.231.3.0/29' } } } }), /uid/);
  assert.throws(() => validateOrgConfig({ orgs: { a: { uid: 0, cpus: 1, memory: '4g', network: { subnet: '10.231.3.0/29' } } } }), /uid/);
});

test('the privileged fallback must be acknowledged and drops in-container sudo', () => {
  const raw = base();
  raw.orgs.edgefleetinc.runtime = 'privileged';
  assert.throws(() => validateOrgConfig(raw), /allowPrivileged/);
  raw.orgs.edgefleetinc.allowPrivileged = true;
  const o = selectOrg(validateOrgConfig(raw), 'edgefleetinc');
  const args = containerCreateArgs(o, 'img');
  assert.ok(args.includes('--privileged'));
  assert.equal(flag(args, '--runtime').length, 0);
  assert.ok(dockerBuildArgs(o, '/kit/container', 'img').includes('RUNNER_SUDO=0'));
  const sysbox = selectOrg(validateOrgConfig(base()), 'edgefleetinc');
  assert.ok(dockerBuildArgs(sysbox, '/kit/container', 'img').includes('RUNNER_SUDO=1'));
});

test('devices and packages are allowlisted', () => {
  const raw = base();
  raw.orgs.edgefleetinc.devices = ['/dev/kvm'];
  raw.orgs.edgefleetinc.aptPackages = ['openjdk-17-jdk-headless', 'cmake'];
  const o = selectOrg(validateOrgConfig(raw), 'edgefleetinc');
  assert.deepEqual(flag(containerCreateArgs(o, 'img'), '--device'), ['/dev/kvm']);
  assert.ok(dockerBuildArgs(o, '/c', 'img').includes('EXTRA_APT_PACKAGES=cmake openjdk-17-jdk-headless'));
  for (const devices of [['/dev/sda'], ['/dev/mem'], ['/dev/kvm', '/dev/kvm'], '/dev/kvm']) {
    raw.orgs.edgefleetinc.devices = devices;
    assert.throws(() => validateOrgConfig(raw), /devices/);
  }
  raw.orgs.edgefleetinc.devices = [];
  raw.orgs.edgefleetinc.aptPackages = ['curl; rm -rf /'];
  assert.throws(() => validateOrgConfig(raw), /aptPackages/);
});

test('limits and keys are validated', () => {
  const bad = patch => () => validateOrgConfig(base(), {}) && validateOrgConfig({ ...base(), orgs: { edgefleetinc: { ...base().orgs.edgefleetinc, ...patch } } });
  assert.throws(bad({ cpus: 0 }), /cpus/);
  assert.throws(bad({ cpus: 1.234 }), /cpus/);
  assert.throws(bad({ memory: '1g' }), /memory/);
  assert.throws(bad({ memorySwap: '8g' }), /memorySwap/);
  assert.throws(bad({ shmSize: '1m' }), /shmSize/);
  assert.throws(bad({ cpusetCpus: '0-7; true' }), /cpusetCpus/);
  assert.throws(bad({ privileged: true }), /unknown key "privileged"/);
  assert.throws(() => validateOrgConfig({ ...base(), dataRoot: 'relative' }), /dataRoot/);
  assert.throws(() => validateOrgConfig({ ...base(), dataRoot: '/srv/a,b' }), /dataRoot/);
  assert.throws(() => validateOrgConfig({ orgs: { YOUR_ORGANIZATION: base().orgs.edgefleetinc } }), /not a GitHub organization name/);
  assert.throws(() => validateOrgConfig({ orgs: {} }), /at least one/);
  assert.equal(parseBytes('512m'), 512 * 1024 ** 2);
  assert.equal(parseBytes(4096), 4096);
  assert.equal(parseBytes('1.5g'), null);
  assert.deepEqual(parseCidr('10.0.0.0/8'), { base: 167772160, prefix: 8, size: 2 ** 24, text: '10.0.0.0/8' });
  assert.equal(parseCidr('10.0.0.256/24'), null);
});

test('the image tag follows the container files and build arguments', () => {
  const o = selectOrg(validateOrgConfig(base()), 'edgefleetinc');
  const tag = imageTag(o, files);
  assert.match(tag, /^actions-runner-fleet-org:edgefleetinc-[0-9a-f]{12}$/);
  assert.equal(imageTag(o, files), tag);
  assert.notEqual(imageTag(o, { ...files, Dockerfile: 'changed' }), tag);
  assert.notEqual(imageTag({ ...o, aptPackages: ['cmake'] }, files), tag);
  // Resource limits are not image inputs.
  assert.equal(imageTag({ ...o, cpus: 4 }, files), tag);
  assert.throws(() => imageTag(o, { ...files, 'daemon.json': undefined }), /container\/daemon\.json is missing/);
  // The real build context has every file the tag covers.
  for (const name of IMAGE_FILES) assert.ok(readFileSync(new URL(`../../container/${name}`, import.meta.url)).length > 0);
});

test('exec runs as the runner in the kit with only its user-manager variables', () => {
  const o = selectOrg(validateOrgConfig(base()), 'edgefleetinc');
  assert.deepEqual(execArgs(o, ['./runnerctl', 'stats', '--json']), ['exec', '--user', 'runner', '--workdir', KIT_DIR,
    '--env', 'XDG_RUNTIME_DIR=/run/user/2101', '--env', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/2101/bus',
    'runner-org-edgefleetinc', './runnerctl', 'stats', '--json']);
});

test('the setup script only creates the org data directories, root-only at the top', () => {
  const config = validateOrgConfig(base());
  const script = setupScript(config, selectOrg(config, 'edgefleetinc'), { source: "/src/it's kit", originUrl: 'https://github.com/example/actions-runner-fleet' });
  assert.match(script, /install -d -o root -g root -m 0711 '\/srv\/data\/runner-orgs'/);
  assert.match(script, /install -d -o 2101 -g 2101 -m 0700 '\/srv\/data\/runner-orgs\/edgefleetinc' '\/srv\/data\/runner-orgs\/edgefleetinc\/home'/);
  assert.match(script, /install -d -o root -g root -m 0700 '\/srv\/data\/runner-orgs\/edgefleetinc\/docker'/);
  assert.match(script, /clone --quiet --no-local '\/src\/it'\\''s kit' '\/srv\/data\/runner-orgs\/edgefleetinc\/kit'/);
  assert.match(script, /chown -R 2101:2101 '\/srv\/data\/runner-orgs\/edgefleetinc\/kit'/);
  assert.match(script, /getent passwd 2101/);
  for (const forbidden of [/systemctl/, /docker /, /loginctl/, /\.runners/, /network/]) assert.doesNotMatch(script, forbidden);
});
