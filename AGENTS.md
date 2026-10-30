# Agent setup guide

Use this guide when a user asks you to set up GitHub Actions self-hosted
runners on their machine from this repository. It sets up the default
deployment: an autoscaled pool of ephemeral runners on this host. README.md is
the full reference; follow it for anything this guide does not cover.

## Ground rules

- Ask the user before changing GitHub or the host. Do not guess the scope,
  target, or repositories; they decide who can run code on this machine.
- Never print, log, commit, or pass a token on a command line. Tokens live
  only in the user's `gh` login or in the owner-only `.autoscale-token` file.
- Never run the whole setup with `sudo`. When a step needs a password or an
  elevated shell, ask the user to run that one command themselves.
- Leave existing runners, services, and other checkouts alone. The autoscaler
  refuses persistent runners; never deregister or stop them to work around that.
- Steps are idempotent; when one fails, fix the cause and rerun it.

## 1. Check the host

Supported hosts are Ubuntu/Linux x86_64, Apple-silicon macOS, and Windows x64.
Stop and tell the user on anything else (Linux ARM, Windows ARM, Intel Macs).

- All hosts: `git`, `curl`, `tar`, and the GitHub CLI (`gh`) must be available.
- Linux: `systemctl --user status` must work (a systemd user manager).
- macOS: Xcode Command Line Tools (`xcode-select -p`). Without them, ask the
  user to run `xcode-select --install`.
- Windows: run every step from an elevated Windows PowerShell 5.1 under the
  account that will own the runners, with Git for Windows installed. Use the
  PowerShell commands in README.md's "Windows hosts" section;
  `.\runnerctl` works like `./runnerctl`.
- At least 10 GiB of free disk beyond about 15 GiB of shared tooling.

## 2. Ask the user

Ask these together, then confirm the resulting `autoscale.json` with the user:

1. **Scope and target.** Should the runners serve one repository
   (`"scope": "repository"`, `"target": "OWNER/REPO"`) or several repositories
   in one organization (`"scope": "organization"`, `"target": "ORG"`)?
   Organization is the usual choice. Enterprise scope and GitHub Enterprise
   Server are not supported by the autoscaler.
2. **Repositories.** Which repositories' queued jobs should start runners? The
   controller polls only the repositories listed; for repository scope, that is
   the target itself.
3. **Labels.** Keep the platform defaults unless their workflows use custom
   `runs-on` labels: `self-hosted`, `Linux`, `X64` on Linux;
   `self-hosted`, `macOS`, `ARM64` on macOS. `prepare.ps1` sets
   `self-hosted`, `Windows`, `X64` on Windows.
4. **Where the kit lives.** Default to `~/actions-runner`. Runner services
   record absolute paths, so the checkout must not move after step 5.

If any target repository is public, warn the user: workflows from forks of a
public repository can run untrusted code on a self-hosted runner.

## 3. Get the code and prepare it

```bash
gh repo clone frankleng/actions-runner-fleet ~/actions-runner
cd ~/actions-runner
./prepare.sh
```

`prepare.sh` verifies the host, downloads and checksums the pinned runner, and
creates an owner-only `autoscale.json` from `autoscale.example.json`. Run all
later commands from this directory.

## 4. Configure GitHub access and `autoscale.json`

The controller needs a GitHub token that can read the queue and create runner
registrations:

- Organization pool: a classic token with `admin:org` and `repo`, from an
  organization owner.
- Repository pool: a classic token with `repo`, from a repository admin.

Run `gh auth status`. If the scopes are missing, ask the user to run
`gh auth login -h github.com -s admin:org,repo,workflow,read:org` (or
`gh auth refresh -h github.com -s admin:org`) themselves; it is interactive.
For an unattended host, README.md's "Autoscaler GitHub token" section shows
how the user stores a dedicated token in `.autoscale-token`, which survives
`gh` re-logins and locked keyrings.

Find the runner group ID. For an organization:

```bash
gh api orgs/ORG/actions/runner-groups --jq '.runner_groups[] | [.id, .name, .visibility] | @tsv'
```

Use the group the user picks (`Default` is usually `1`), and check that every
listed repository can use it. Repository pools use `1`.

Edit `autoscale.json`: set `scope`, `target`, `repositories`, `labels`, and
`runnerGroupId`. Keep `minRunners` and `maxRunners` at `"auto"`, which sizes
the pool from this host's CPUs and memory, unless the user asks otherwise.
Keep the file mode `0600` (`chmod 600 autoscale.json`).

## 5. Install

Preview one poll first. It is read-only and checks authentication, the runner
group, and the queue:

```bash
./runnerctl autoscale --dry-run
```

Fix any error it reports before continuing.

On macOS, runner services are root LaunchDaemons, so installing them needs an
administrator password. Before the next step, ask the user to run this once in
their own terminal. It allows only validated runner-service commands without a
password:

```bash
sudo ./install-launchd-helper.sh
```

Then provision the slots and start the background controller:

```bash
./runnerctl autoscale --prepare
```

This provisions shared tooling (several minutes on first run), installs one
service per slot, and enables the controller at boot. On Linux, if it warns
that login lingering could not be enabled, ask the user to run
`sudo loginctl enable-linger "$USER"`, or the runners stop at logout. On
macOS the controller is a launchd agent that starts at login, so the account
must be logged in (or set to log in automatically) for the pool to scale.

## 6. Verify and report

```bash
./runnerctl stats
./runnerctl health --dry-run
```

`stats` lists the slots, and `health --dry-run` should report no problems
after the controller's first poll (about a minute). Runners register with
GitHub only when jobs queue, so an empty runner list on GitHub is expected
while nothing is queued. To prove the pool end to end, offer to run a workflow
with `runs-on` set to the configured labels and watch it pick up a job.

Tell the user where the kit lives and the day-to-day commands:
`./runnerctl` (dashboard), `./runnerctl stats`, `./runnerctl autoscale --disable`
(stop scaling; running jobs finish), and `./runnerctl autoscale --enable`.

For a manually managed fleet of persistent runners instead of autoscaling, or
for moving runners between machines, follow README.md.
