# Organization containers (Linux)

Status: design and implementation on branch `org-containers`; not rolled out.
Opt-in per organization. Host-mode runners and the macOS and Windows kits are
unchanged and stay the default.

This document is the plan: the problem, the design, its security boundaries,
the configuration, lifecycle, credentials, devices, networking, performance,
host prerequisites, and a migration runbook. The README's
[Organization containers](../README.md#organization-containers-linux) section
is the day-to-day reference.

## Problem

On a Linux host today every runner slot is a systemd user service of one
account. On the host this was designed for, that account is also the owner's
interactive login and has passwordless `sudo`. All three organizations
(edgefleetinc, titledock, founderationhq) share:

- one network namespace;
- one Docker daemon;
- the account's systemd user environment;
- the host filesystem, with the account's permissions;
- the CPU. Each slot has its own `CPUQuota`, but no organization has a cap.

Confirmed incidents (2026-11-16/17), and what inspection for this plan added:

1. **Leaked Cloudflare login.** Jobs inherited the account's `XDG_CONFIG_HOME`.
   An edgefleet job's wrangler used the owner's personal Cloudflare login and
   wrote secrets into another organization's account. c762d30 patched this
   with per-slot XDG directories.
2. **Session secrets in every job.** The systemd user manager's environment
   reaches every slot process. In `/proc/<pid>/environ` of a live edgefleet
   slot (names checked, values not read): `CLIPROXY_API_KEY`, `SSH_AUTH_SOCK`,
   `GPG_AGENT_INFO`, `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, `XAUTHORITY`. So
   any job step of any organization can read the API key, use the owner's SSH
   agent and keys, and talk to the desktop session bus, including its keyring.
3. **Personal tools on `PATH`.** The provisioned slot `PATH` (`.path`) keeps
   the service account's own `~/.local/bin` and pnpm global `bin`. Jobs
   therefore run the owner's shims: `cc`/`gcc` (a `zig cc` wrapper), a
   personal `make`, `gh`, `java`, and Android `adb`/`emulator` shims.
4. **Docker network churn breaks other orgs' browsers.** `titledock/turbofan`
   jobs with `services:` (`postgres:17`, `amazon/dynamodb-local`, for example
   `sync-repair-tests.yml`) make the runner create and delete a
   `github_network_<guid>` bridge per job, about 11 per hour. Each one adds and
   removes a host IP address. Headless Chromium in edgefleet's Playwright e2e
   job sees the change and aborts in-flight `127.0.0.1` requests with
   `net::ERR_NETWORK_CHANGED`, so pages never hydrate. The host's own netlink
   log also attributes address events to per-container veths (52) and
   `docker0` (12), not only to the job bridges. Any bridged container on the
   host contributes.
5. **CPU contention.** Titledock slots used up to 20 of 32 threads. That
   slowed edgefleet's single-threaded e2e from about 4 to 9–18 minutes.
6. **One shared admin token.** One kit holds a classic PAT with `admin:org`
   for titledock and also hosts founderationhq's runners. Any job on the host
   can read every kit's token file, since all kits belong to the same account.

Incidents 2, 3 and 6 are reachable today from any job of any organization.
Fixing them in host mode needs `UnsetEnvironment=` (or an allowlist in
`runsvc.sh`), `PATH` filtering of the account's home, and separate accounts.
That is worth doing for hosts that stay in host mode; it is a separate change
from this opt-in feature (see [Out of scope](#out-of-scope)).

## Design

One long-lived container per organization on a Linux host:

```text
host (systemd, dockerd, Sysbox)
├── bridge rf-edgefleetinc 10.231.1.0/29 ── container runner-org-edgefleetinc (--cpus 8 --memory 16g)
│     systemd (PID 1)
│     ├── docker.service             the org's own daemon: job services:/container: live here
│     └── user@2101.service          the runner account, lingering
│         ├── runnerctl-autoscale-…  the unchanged kit controller, "capacity": "cgroup"
│         └── actions.runner.edgefleetinc.<slot>   one per slot, CPUQuota from the controller
├── bridge rf-founderationhq … ── container runner-org-founderationhq
└── bridge rf-titledock … ── container runner-org-titledock
```

- **systemd is PID 1 in the container.** Everything below it is the existing
  kit, unmodified: `prepare.sh`, `runnerctl autoscale --prepare`, the systemd
  user services, linger, job hooks, runner updates, `runnerctl stats`, and
  `runnerctl health`. That is why Sysbox is the runtime. It runs systemd and
  dockerd in an unprivileged container without `--privileged`. A
  non-systemd supervisor would have meant rewriting the service layer for one
  platform.
- **The kit lives on a bind mount** at `/runner/kit`. It's a separate clone of
  this repository per organization. `.runners/`, `host-tools/`, the pnpm store,
  the tool cache and `_work` are therefore on `/srv/data` at native disk speed,
  never in the container's overlay layer. The runner's home
  (`/home/runner`, holding the controller's systemd user units), `/tmp`, and
  `/var/lib/docker` are bind mounts too. Rebuilding or recreating the container
  keeps all runner state and the org's Docker images.
- **The image carries only the OS:** Ubuntu 26.04 like the host, a build
  toolchain, Chromium's system libraries, git, git-lfs, gh, and Ubuntu's own
  `docker.io` 29.1 with buildx and compose. It has no third-party apt
  repository or signing key. Organization-specific packages go in
  `aptPackages`. The image tag is a hash of `container/` and the build
  arguments, so `runnerctl org status` can tell when an org runs an outdated
  image.
- **The autoscaler sizes from the container, not the host.** Inside a
  `--cpus/--memory` container, `os.totalmem()` and the load average still
  describe the whole host. Validated in a `--cpus 2 --memory 4g` container on
  this host: the existing code read 90 GiB of memory and a load of 35.95 per
  CPU (the host's load ÷ 2). That would have put the pool in permanent
  pressure and sized it for memory it cannot use. The new `"capacity":
  "cgroup"` setting in `autoscale.json` reads the cgroup v2 limits on the
  controller's chain (`cpu.max`, `memory.max`). It measures load as the busy
  fraction of the CPU quota plus time spent waiting for a CPU
  (`cpu.pressure`), so other tenants don't count and `lowLoad`/`highLoad`
  keep their meaning. Free memory is measured under the limit, with
  reclaimable page cache counted as free, and bounded by what the host still
  has. In the same container the new code read 2 CPUs and 4 GiB, a load of
  0.01 idle and 1.06 with three busy threads. The default stays `"host"`.
- **Lifecycle is `runnerctl org`** (`runnerctl-app/bin/runnerctl-org.mjs`).
  It validates `org-containers.json` and renders every Docker command from
  one pure module (`runnerctl-org-container.mjs`), so `render` and
  `--dry-run` print exactly what would run. It calls Docker with argument
  arrays only, never through a shell.

### Changes from the brief

- **Per-org UIDs on the host, not the owner's.** Each org's runner account
  has its own UID (for example 2101), unused on the host. With Sysbox's
  ID-mapped mounts, files in an org's data directory belong to that UID on the
  host too, not to the owner's login. The data root is root-only (`0711`) and
  each org directory is `0700`. So neither host-mode jobs running as the owner
  nor another organization's container can read an org's token or workspace.
- **No systemd unit on the host.** Docker's `--restart unless-stopped`
  restarts each container at boot, and a deliberate `stop` survives reboots.
  A host unit that wraps `docker start -a` would fight that policy. The
  lifecycle commands are explicit and refuse unsafe states instead.
- **Founderationhq has no autoscaler today.** `littlebeast-fdn-1..3` are
  persistent runners in the titledock kit's registry (labels `self-hosted`,
  `founderation`). Its migration creates a new autoscaled pool. The persistent
  runners are removed only after the pool proves itself.
- **Per-org containers don't fully solve titledock's own churn.** Turbofan has
  both `services:` jobs and Playwright jobs. Inside titledock's container its
  service jobs still create bridges in the org's own network namespace, and
  its own Chromium jobs can still see those address changes. Other orgs are
  isolated from it. Disabling IPv6 in the container (the default) removes the
  link-local address events from per-container veths. Whatever remains is
  titledock's own, and the fix is per-job network namespaces (see
  [Out of scope](#out-of-scope)).
- **The token is narrower but still job-readable.** Jobs and the controller
  share the runner account inside the container, as on the host. A job can
  read its own org's controller token, but no longer another org's token, the
  owner's `gh` login, or the session secrets above. That's why each org gets
  its own token scoped to that org (see [Credentials](#credentials)).

## Security boundaries

What the container isolates, per organization, under Sysbox:

| Shared today | In an org container |
| --- | --- |
| Network namespace and host IPs | Own netns; one host bridge created once; job bridges stay inside |
| Docker daemon, images, volumes | Own `dockerd` and `/var/lib/docker`; the host socket is never mounted |
| Owner's systemd user environment | The image's environment only: `PATH` and `LANG=C.UTF-8`; nothing from the host |
| Owner's home, XDG, `~/.local/bin`, SSH agent, session bus | Not mounted or reachable |
| Host filesystem with the owner's rights | Only the org's four data directories |
| Passwordless host `sudo` | `sudo` inside reaches container root, which Sysbox maps to an unprivileged host UID range |
| CPU and memory | `--cpus`, `--memory` (no swap), `--pids-limit` per org; slot quotas nest inside |
| Every org's token file | Only the org's own token |

What it doesn't isolate:

- **Jobs within one org** share the container, the runner account, the Docker
  daemon, the token file, and each other's workspaces. That's the same as
  today within a kit. Ephemeral registrations aren't a sandbox between jobs.
- **The kernel.** Sysbox is a container runtime, not a VM. A kernel exploit
  escapes it. Sysbox CE also maps every container to the same host UID range,
  so after an escape, containers aren't separated from one another by UID.
- **Outbound network.** Containers reach the internet, the LAN, and host
  services that listen on the bridge gateway, unless the host firewall rule in
  [Host prerequisites](#host-prerequisites) is applied. Docker already blocks
  traffic between user-defined bridges.
- **Container root writing to bind mounts.** With ID-mapped mounts, a file
  that container root creates in `/runner/kit` or `/tmp` is owned by root on
  the host. It could even be setuid. The root-only data root keeps host users
  from reaching such files. A `nosuid,nodev` bind mount of the data root (see
  [Host prerequisites](#host-prerequisites)) makes them inert.
- **Host-mode orgs.** Until every org is moved, host-mode jobs still run as
  the owner with passwordless `sudo`, so they can still read everything,
  including the container data root. The isolation is complete only when the
  last org is migrated and host-mode runners stop.

### Docker in the container

- **Sysbox (`sysbox-runc`, default).** It uses a user namespace with ID-mapped
  mounts, emulates `/proc` and `/sys` where needed, and handles
  `/var/lib/docker` mounts specially so the inner dockerd can use
  `overlay2`. systemd and dockerd run without privileges or capabilities on
  the host. Costs: one host install that needs root, and a Docker daemon
  restart to register the runtime. Sysbox CE also has a slower release cadence
  than Docker. Its documented support stops at Ubuntu 24.04 and does not list
  26.04 or kernel 7.0, so the first rollout step is a canary (gate G1 below).
- **Privileged DinD (`"runtime": "privileged"`, fallback).** Plain runc with
  `--privileged`. It needs no new software, but **root in the container is
  root on the host**: all capabilities, every device, writable `/sys`, and an
  unmodified seccomp/AppArmor profile. A job with `sudo` would own the host.
  So the fallback builds the image with `RUNNER_SUDO=0`, and the config must
  say `"allowPrivileged": true`. Even then, a job escaping the runner account
  through any local privilege escalation becomes host root. It still fixes the
  network churn, the inherited environment, and CPU contention. It doesn't fix
  privilege. Use it only as a stopgap.
- **Rejected options.**
  - Mounting the host socket recreates incident 4 and gives every job host root.
  - Rootless Docker per org on the host avoids the bridge churn, but needs host
    accounts, `newuidmap` setup, and `slirp4netns`/`pasta` networking (slower).
    It also gives no `sudo` for jobs that run `apt`.
  - Podman isn't compatible with the runner's Docker CLI calls for `services:`
    without a socket shim.

## Configuration

`org-containers.json` sits in the host checkout that administers the
containers. It is ignored by Git, and must be owned by you and writable only
by you, because it decides what Docker runs as root. Start from
`org-containers.example.json`:

```json
{
  "dataRoot": "/srv/data/runner-orgs",
  "orgs": {
    "edgefleetinc": {
      "uid": 2101,
      "cpus": 8,
      "memory": "16g",
      "network": { "subnet": "10.231.1.0/29" }
    }
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `dataRoot` | `/srv/data/runner-orgs` | Root-only parent of every org's data directory |
| `uid` | required | Runner UID inside, and owner of the org's files on the host; 2000–59999, unique, unused on the host |
| `runtime` | `sysbox-runc` | Or `privileged` (needs `"allowPrivileged": true`) |
| `cpus` | required | `--cpus`: a CPU-time ceiling, not a reservation |
| `cpusetCpus` | none | Optional `--cpuset-cpus` pinning, for example `"0-7"` |
| `memory` / `memorySwap` | required / = memory | Hard memory limit; equal values mean no swap |
| `pidsLimit` | 32768 | Process limit for the whole org |
| `shmSize` | `2g` | `/dev/shm`; Chromium fails with Docker's 64 MiB default |
| `network.subnet` | required | Aligned IPv4 /16–/29, outside `10.200.0.0/15` (inner Docker) and `172.17.0.0/16` |
| `network.name` / `network.bridge` | `runner-org-<org>` / `rf-<org>` | Docker network and host interface name (at most 15 characters) |
| `disableIpv6` | `true` | No IPv6 in the org namespace, so no link-local address events |
| `devices` | `[]` | Only `/dev/kvm`, `/dev/fuse`, `/dev/net/tun` |
| `aptPackages` | `[]` | Extra Ubuntu packages baked into the org's image |
| `baseImage` | `ubuntu:26.04` | Image base; pin a digest for reproducible builds |
| `hostname` | `<host>-<org>` | Container hostname; health alerts use it |
| `stopTimeoutSeconds` | 120 | Grace period for `docker stop` |

Each org's own `autoscale.json` (in its kit, inside the container) is the
normal kit configuration plus `"capacity": "cgroup"`. Its slot names must
differ from any host-mode pool's slot names while both exist.

Data layout per organization:

| Host path | In the container | Owner (host) |
| --- | --- | --- |
| `<dataRoot>` | — | root, `0711` |
| `<dataRoot>/<org>` | — | org UID, `0700` |
| `<org>/kit` | `/runner/kit` | org UID |
| `<org>/home` | `/home/runner` | org UID |
| `<org>/docker` | `/var/lib/docker` | root (Sysbox maps it) |
| `<org>/tmp` | `/tmp` | root, `1777` |

The inner daemon (`container/daemon.json`) uses `bip 10.200.0.1/24` and job
pools from `10.201.0.0/16`. It uses the `overlay2` graph driver rather than
the containerd image store, so all its state is under the one persisted
`/var/lib/docker`. Logs use the `local` driver, capped at 30 MiB per
container. The container's journal is volatile and capped at 64 MiB.

## Lifecycle

```bash
./runnerctl org check-host              # Docker, sysbox-runc, cgroup v2, data dirs, networks, containers
./runnerctl org render ORG              # every command below, printed, nothing run
./runnerctl org setup-script ORG        # the one-time root script for ORG's data directories
./runnerctl org build ORG               # image; tag = hash of container/ + build args
./runnerctl org network ORG             # the org bridge, once; afterwards only verified, never changed
./runnerctl org create ORG              # refuses without image, network, data dirs, and runtime
./runnerctl org start ORG               # waits for the HEALTHCHECK (systemd, dockerd, user manager, kit)
./runnerctl org drain ORG               # autoscaler --disable, then wait for two idle checks 15 s apart
./runnerctl org stop ORG [--force]      # refuses while a job runs
./runnerctl org upgrade ORG             # build, drain, stop, rm, create, start, re-enable if it was enabled
./runnerctl org status [ORG] [--json]   # one row per org
./runnerctl org stats [ORG] [--json]    # runnerctl stats from every container, one row per runner
./runnerctl org exec ORG -- CMD...      # CMD as the runner in /runner/kit; stdin passes through
```

- **Boot.** dockerd restarts every container with `unless-stopped`. Inside,
  systemd starts dockerd and the lingering runner's user manager. That starts
  the autoscaler, which restarts slots exactly as on a host.
- **Stop and drain.** A job is "running" while a `Runner.Worker` process
  exists. `stop` refuses then, unless you pass `--force`. Disabling the
  controller leaves idle warm listeners registered, and one can still accept a
  job until the container stops. `drain` therefore needs two idle checks in a
  row, but a job assigned in the final seconds before the stop can still fail
  as "lost communication". Drain at quiet times.
- **Upgrade.** State lives on the bind mounts, so recreating the container is
  safe. `upgrade` does nothing when the image and settings hash already match.
  Kit updates are a `git pull` in the org's kit, followed by
  `runnerctl org exec ORG -- ./runnerctl autoscale --enable`, which rewrites
  and restarts the controller. Slots pick up worker changes at their next
  supervisor restart, as on a host.
- **Status and health.** The image's `HEALTHCHECK` runs `runner-org-status
  --health` every minute. `runnerctl org status` adds the image and settings
  drift and, from inside, the autoscaler state, listener count and job count.
  `runnerctl health --install` works unchanged inside each container (systemd
  user timers). Its alerts carry the container hostname, `<host>-<org>`.

## Credentials

The controller still uses JIT configurations and never registration tokens.
What changes is the token's scope and where it lives:

- **One token per org, for that org only.** Use a fine-grained PAT whose
  resource owner is the organization, with organization **Self-hosted runners:
  read and write** and repository **Actions: read** on the configured
  repositories (README, [Autoscaler GitHub token](../README.md#autoscaler-github-token)).
  The organization may have to approve it. Its owner must be an org owner. It
  cannot touch other organizations, repository contents, or anything outside
  runners, unlike today's classic `admin:org` + `repo` PAT. Give it an expiry
  and a calendar reminder.
- **Stored only inside the org's kit**, as `/runner/kit/.autoscale-token`:
  mode `0600`, owned by the org UID, under the root-only data root. It is
  piped in on stdin, never put in an argument or environment variable:

  ```bash
  read -rs -p 'Token: ' t && printf '%s\n' "$t" |
    ./runnerctl org exec ORG -- sh -c 'umask 077 && cat > .autoscale-token'; unset t; echo
  ```

  `printf` is a shell builtin, so the token never appears in a process list.
- **Health alerts.** A fine-grained token covers one owner. Point
  `.health-github-repo` at a repository in the same organization, or use the
  webhook target. Otherwise health reports `runner-unverified` for GitHub
  checks.
- **Exposure that remains.** A job in org X can read org X's runner token
  (shared account) and use it until rotation: to register runners in X or
  read X's queue. It can't reach other orgs, the owner's `gh` login, SSH
  agent, or keyring. Splitting the controller into its own account is out of
  scope. A GitHub App installation token (hourly, scoped by installation)
  would shorten the window further; the kit doesn't support App auth yet.

## Devices

Inspected read-only on this host: every turbofan checkout under
`.runners/*/_work/turbofan` (newest `c9b6756d4af`, 2026-11-18), plus the
edgefleetinc and founderation workflows on disk.

- No workflow uses `/dev/kvm`, an Android emulator or AVD, `--device`,
  `--privileged`, or `--cap-add`. `apps-mobile.yml` builds Android with
  Gradle only (`android-actions/setup-android`, `actions/setup-java`
  temurin 17). It builds no `x86_64` emulator slices and starts no emulator.
- The `emulator`/`avdmanager` shims on `PATH` today are the owner's personal
  tools (incident 3), not something jobs call.
- What jobs do need from the host: Docker for `services:`, Chromium's system
  libraries (turbofan's `install-playwright-chromium` falls back to `sudo
  playwright install-deps`), and `sudo apt-get` in some jobs. The image ships
  the libraries, and Sysbox makes in-container `sudo` safe.

So no device passthrough is configured. If a future job needs KVM, add
`"devices": ["/dev/kvm"]` to that org. Sysbox passes the node through, and
the runner needs the device's group inside, so add the group in the image or
run `chmod 0666` from a boot unit. Hardware-accelerated emulators still need
`/dev/kvm` on the host, plus enough memory headroom in the org's limit.

## Networking

- **One interface per org, created once.** `runnerctl org network ORG`
  creates a user-defined bridge with a fixed subnet and bridge name, with
  inter-container traffic disabled (one container per bridge). Docker keeps
  the bridge and its gateway address while the network exists, so there's
  exactly one host address change per org, at setup. Starting the container
  adds one veth; nothing else changes on the host. `network` never modifies
  an existing network. It verifies the driver, subnet and bridge and refuses
  a mismatch.
- **Jobs never touch the host network.** `services:`/`container:` jobs make
  the inner dockerd create `github_network_*` bridges and veths inside the
  org's namespace. The host and other orgs' Chromium can't see them.
- **IPv6 is off** in each org namespace by default (`disableIpv6`). This
  removes the link-local address events from the inner veths, which the
  host's evidence showed are noticed too.
- **Fixed addresses.** The gateway is `.1` and the container `.2` of the org
  subnet. The suggested plan is edgefleetinc `10.231.1.0/29`, founderationhq
  `10.231.2.0/29` and titledock `10.231.3.0/29`. No host route overlaps
  `10.231.0.0/16` today.
- **DNS** is Docker's embedded resolver for user-defined networks, served from
  dockerd in the host namespace.
- **The host firewall** (optional, recommended; see prerequisites) drops new
  connections from `rf-*` bridges to the host itself, so containers can't
  reach services that bind to all interfaces.

## Performance

Expected overhead:

- **CPU:** about 0. Processes run natively; quotas are the same CFS mechanism
  slots already use.
- **Memory:** about 100–200 MiB per org, for dockerd, containerd, systemd and
  journald.
- **Disk:** bind mounts are native XFS. Inner `overlay2` layers are on the
  host's `/srv/data` volume.
- **Network:** one NAT hop, the same as any bridged container.

Benchmark before switching each org. Run it on a quiet host (no titledock
burst; record `uptime` and `./runnerctl stats` before each run), three runs
per mode, and compare medians:

1. Prepare a canary pool in the container with an extra label (for example
   `org-container`), and a workflow in the org's repository whose jobs run on
   either `[self-hosted, Linux, X64, littlebeast]` (host pool) or
   `[..., org-container]` (container pool).
2. Run the same three jobs in each mode:
   - (a) the org's real critical job: edgefleet's Playwright e2e, which is
     single-threaded and took about 4 minutes on an idle host;
   - (b) a warm-cache `pnpm install --frozen-lockfile && pnpm -r build`;
   - (c) a `services: postgres:17` job: time from job start to the service
     being healthy, plus a short `psql` workload.
3. Record wall time from job logs and the controller's quota (`runnerctl
   stats`). Inside the container, record idle memory
   (`ps -o rss= -C dockerd,containerd,systemd,systemd-journald` and the
   container's `memory.current`) and `docker stats --no-stream
   runner-org-ORG`.
4. Acceptance: container median within 3% of host median for (a) and (b); (c)
   within 5 s; inner daemon idle RSS under 250 MiB.

## Host prerequisites

These need root once per host, and are listed so the owner can approve them
separately. Nothing in the kit runs them.

1. **Gate G1: Sysbox on this host.** Ubuntu 26.04 with kernel 7.0 is newer
   than Sysbox CE's documented support, and the host Docker uses the
   containerd image store (`docker info`: `io.containerd.snapshotter.v1`).
   Prove both with a canary container before migrating anything (runbook step
   E3). If Sysbox fails, fall back per org to the privileged runtime as a
   documented stopgap, or wait for a Sysbox release.
2. **Install Sysbox CE.** Download the release `.deb` for amd64 from
   `github.com/nestybox/sysbox/releases` and verify its published SHA-256.
   Then run `sudo apt-get install ./sysbox-ce_<version>.linux_amd64.deb`.
   The package registers `sysbox-runc` in `/etc/docker/daemon.json`, adds a
   `sysbox` subordinate UID range, and **restarts dockerd**. On this host that
   restart stops every running container, including titledock's job services.
   The installer also refuses to run while containers are running. Schedule it
   with titledock drained: in its kit run `./runnerctl autoscale --disable`,
   wait for `docker ps` to show no job containers, install, then
   `./runnerctl autoscale --enable`. Verify with `docker info -f '{{json
   .Runtimes}}'` and `systemctl status sysbox`.
3. **Data root and per-org directories:** run the output of
   `./runnerctl org setup-script ORG` with `sudo`. It creates `dataRoot` as
   root-owned `0711` and the org's directories with the right owners. It
   clones this checkout into the org's kit and chowns it to the org UID. It
   refuses a UID that belongs to a host account.
4. **Recommended hardening:**
   - Make the data root `nosuid,nodev`: add the `/etc/fstab` line
     `/srv/data/runner-orgs /srv/data/runner-orgs none bind,nosuid,nodev 0 0`,
     then run `mount /srv/data/runner-orgs` and `findmnt
     /srv/data/runner-orgs`.
   - Drop container-to-host connections, persisted with the host's firewall
     tooling. For example:
     `nft add table inet runner_orgs`, then
     `nft 'add chain inet runner_orgs input { type filter hook input priority 0; policy accept; }'`,
     `nft add rule inet runner_orgs input iifname "rf-*" ct state established,related accept`,
     `nft add rule inet runner_orgs input iifname "rf-*" drop`.
     Allow specific ports first if an org must reach a host service.

## Migration runbook

Order: edgefleetinc, then founderationhq, then titledock. Switch an org only
while its slots are idle. The host kits stay untouched and ready for rollback
until each org has run for a week. Every step marked **live** changes the host
or GitHub and needs the owner's approval at that time.

### edgefleetinc

- **E1 (live, root).** Host prerequisites 2–4 for edgefleetinc. Install
  Sysbox in a titledock-quiet window.
- **E2.** On the administering checkout, write `org-containers.json`
  (`uid` 2101, `cpus` 8, `memory` `16g`, `subnet` `10.231.1.0/29`). Then run
  `./runnerctl org check-host` and `./runnerctl org render edgefleetinc`.
- **E3 (live).** Build the image (`./runnerctl org build edgefleetinc`). Then
  run the canary for gate G1, with no network or mounts:
  `docker run -d --rm --runtime sysbox-runc --network none --name
  rf-canary IMAGE`. Wait for `docker exec rf-canary systemctl
  is-system-running` to report `running` or `degraded`. Check the inner
  daemon with `docker exec rf-canary docker info`. Then check that a job
  bridge works and stays inside: run `docker exec rf-canary docker network
  create t && docker exec rf-canary docker network rm t` while `ip monitor
  address` runs on the host, which should print nothing. Also check
  `docker exec rf-canary systemctl is-active user@2101.service`. Then run
  `docker stop rf-canary`.
- **E4 (live).** Create the network (`./runnerctl org network edgefleetinc`)
  while no edgefleet job is running. This is the single host address change.
- **E5 (live).** Run `./runnerctl org create edgefleetinc` and
  `./runnerctl org start edgefleetinc`. Check the mounts from inside:
  `./runnerctl org exec edgefleetinc -- stat -c '%u %n' /runner/kit`
  should print `2101`.
- **E6.** Inside the container:
  - `./runnerctl org exec edgefleetinc -- ./prepare.sh`;
  - copy the live `autoscale.json` content into the container kit, with new
    slot names (`littlebeast-edgefleet-c1`, `-c2`), `"capacity": "cgroup"`,
    and an extra canary label `org-container`;
  - pipe in a new fine-grained edgefleetinc token ([Credentials](#credentials));
  - `./runnerctl org exec edgefleetinc -- ./runnerctl autoscale --dry-run`.
- **E7 (live).** Run
  `./runnerctl org exec edgefleetinc -- ./runnerctl autoscale --prepare`.
  Container slots now serve only jobs that ask for `org-container`. Run the
  benchmark. Run edgefleet's e2e on the canary pool during a titledock
  service-job burst and confirm there's no `ERR_NETWORK_CHANGED`.
- **E8 (live, cutover)** while both pools are idle:
  1. In the host kit, run `./runnerctl autoscale --disable` and wait until
     its slots show no job.
  2. In the container kit, remove the `org-container` label from
     `autoscale.json`; the next poll applies it.
  3. Run `./runnerctl org exec edgefleetinc -- ./runnerctl health --install`.
- **E9.** After a week without problems, uninstall the host slots' services
  in the old kit. Remove their GitHub registrations only if any remain. Revoke
  the shared PAT's use for edgefleetinc.

**Rollback** (any time before E9): `./runnerctl org drain edgefleetinc &&
./runnerctl org stop edgefleetinc`, then `./runnerctl autoscale --enable` in
the host kit. Nothing on the host kit changed, so it resumes as before.
Remove the container with `docker rm runner-org-edgefleetinc`. Removing the
network (`docker network rm runner-org-edgefleetinc`) is one more host
address change, so do it while idle.

### founderationhq

Same as E2–E8, with `uid` 2102 and `10.231.2.0/29`, labels `self-hosted`,
`founderation`, and a new fine-grained founderationhq token. The pool is new
(see [Changes from the brief](#changes-from-the-brief)). Cut over by stopping
the persistent `littlebeast-fdn-*` services in the titledock kit
(`./manage-runners.sh stop NAME`) once they are idle. Remove their GitHub
registrations only after a week. Rollback is starting those services again.

### titledock

Same steps, with `uid` 2103, `10.231.3.0/29`, a cap such as `cpus` 20 and
`memory` `48g`, and `"capacity": "cgroup"`. Add an `aptPackages` entry for
anything its jobs got from the host `PATH`: run the full turbofan workflow set
on the canary pool first, especially `apps-mobile` (JDK/Android via setup
actions), the Playwright jobs, and the services jobs. Prepare the container
pool ahead of time, then cut over during a quiet window: disable the host
autoscaler and wait for its 16 slots to drain. Titledock's own Playwright jobs
can still see its own service-job bridges (residual risk above).

## Validation status (this branch)

- **Verified on this host, without touching live state:**
  - Node unit tests (config validation, rendering, the cgroup sampler) and the
    `tests/org-container-smoke.sh` lifecycle test, against a stub `docker`.
  - The image builds: Ubuntu 26.04, Docker 29.1.3, 2.2 GB. A throwaway
    `--network none` container showed that only `PATH`/`HOSTNAME`/`HOME` reach
    it, that the runner is UID 2101 with linger, that `dockerd --validate`
    accepts `daemon.json`, and that all tools and Chromium libraries resolve.
  - The cgroup capacity readings in a real `--cpus 2 --memory 4g` container.
  - shellcheck (via the `koalaman/shellcheck` image, `--network none`) on the
    new shell scripts.
- **Not verified, because Sysbox isn't installed and installing it was out of
  bounds:**
  - systemd booting in the container, and dockerd running inside it;
  - linger starting the user manager;
  - cgroup delegation of per-slot `CPUQuota` inside;
  - ID-mapped ownership of the bind mounts;
  - `docker create --runtime sysbox-runc` with these flags;
  - Sysbox on Ubuntu 26.04 / kernel 7.0 with the containerd image store
    (gate G1);
  - the benchmark.

  Runbook steps E3–E7 verify each of these before any cutover.

## Out of scope

- Host-mode hardening of incidents 2, 3 and 6 for orgs that stay on the host:
  scrubbing the service environment and `PATH`, and per-org accounts. It's
  recommended as a separate change.
- Per-job isolation inside one org: per-job network namespaces or VMs (for
  example Firecracker or ARC), and container hooks that avoid job bridges.
- Running the controller under a different account from the jobs, and GitHub
  App authentication.
- macOS and Windows hosts, and multi-host scheduling.
- A CPU reservation or weight per org (`--cpu-shares`). `--cpus` is a ceiling.
  Before titledock is capped, edgefleet in its container competes with host
  slots at the `system.slice` versus `user.slice` level, which already favours
  it more than today's shared slice.
