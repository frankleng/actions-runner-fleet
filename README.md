# Actions Runner Fleet

Set up and manage one or more GitHub Actions self-hosted runners on an
Apple-silicon Mac. The kit supports organization-level and repository-level
runners, multiple GitHub targets, launchd services, a terminal dashboard, and
repeatable migration to a replacement Mac.

This repository is private, but it is still designed to contain **no private
credentials**. Runner registration tokens, generated runner credentials,
workspaces, logs, caches, environment snapshots, keychains, and downloaded
tools are never committed.

## What gets installed

- GitHub Actions Runner `2.336.0` for macOS arm64, verified by SHA-256
- One isolated directory and launchd user agent per runner
- Pinned runner-local Node.js, pnpm, Wrangler, Pulumi, and AWS CLI tooling
- A terminal dashboard for status, registration, start, stop, and reconcile
- Log rotation and cleanup for runner and launchd diagnostics

The setup is intentionally for **Apple-silicon macOS**. It does not configure
Linux, Windows, or Intel Macs.

## Requirements

- Apple-silicon Mac using a native `arm64` shell
- A macOS account that remains logged in while its launchd agents run
- Network access to GitHub, Node.js, npm, Pulumi, and AWS download endpoints
- Node.js and npm when building from this source checkout
- Admin access to each GitHub organization or repository that will own runners
- About 15 GiB per runner plus at least 10 GiB of free headroom

Xcode, Swift, and CocoaPods are optional unless your workflows build Apple
software. Install them before cutover when your jobs use `xcodebuild`,
`swiftc`, `codesign`, or `pod`.

## Fastest setup: use the private release

Open this repository's **Releases** page and download:

- `actions-runner-fleet-kit-macos-arm64-2.336.0.tar.gz`
- `actions-runner-fleet-kit-macos-arm64-2.336.0.tar.gz.sha256`

Authenticated GitHub CLI users can download the latest release instead:

```bash
mkdir actions-runner-download
cd actions-runner-download
gh release download \
  --repo frankleng/actions-runner-fleet \
  --pattern 'actions-runner-fleet-kit-macos-arm64-*.tar.gz*'
shasum -a 256 -c actions-runner-fleet-kit-macos-arm64-2.336.0.tar.gz.sha256
tar -xzf actions-runner-fleet-kit-macos-arm64-2.336.0.tar.gz
mv actions-runner-fleet-kit-macos-arm64-2.336.0 ../actions-runner
cd ../actions-runner
```

Move or rename the extracted directory **before** registering runners. The
local registry records absolute runner-directory paths.

## Setup from the source repository

Clone the private repository and prepare the checkout:

```bash
gh repo clone frankleng/actions-runner-fleet actions-runner
cd actions-runner
./prepare.sh
```

`prepare.sh` verifies the host, downloads the pinned official runner archive,
checks its SHA-256, installs the dashboard dependency, and creates an ignored
`fleet.tsv` from `fleet.example.tsv`.

## Configure your fleet

Edit `fleet.tsv`. It is tab-delimited with three columns:

```text
token-key	GitHub organization or repository URL	runner name
MY_ORG	https://github.com/my-organization	mac-arm64-1
MY_ORG	https://github.com/my-organization	mac-arm64-2
MY_REPO	https://github.com/my-user/my-repository	repo-mac-1
```

Rules:

- Use real tab characters between columns.
- `token-key` must contain only uppercase letters, numbers, and underscores.
- Rows sharing a token key must use the same GitHub URL.
- Every runner name must be unique in the file.
- Runner names may contain letters, numbers, dots, underscores, and hyphens.
- Do not put a token, password, secret, or personal access token in this file.

Each token key becomes an optional environment-variable prefix. For example,
`MY_ORG` maps to `MY_ORG_RUNNER_REGISTRATION_TOKEN`.

The release contains a placeholder `fleet.tsv`; replace every `CHANGE_ME`
value before continuing.

## Generate registration tokens

GitHub runner registration tokens are short-lived and normally expire after
about one hour. Generate them immediately before setup:

- Organization runner: organization **Settings → Actions → Runners → New
  self-hosted runner**
- Repository runner: repository **Settings → Actions → Runners → New
  self-hosted runner**

Select macOS and ARM64 if GitHub asks for a platform. This kit needs only the
registration token from that page; do not paste the displayed installation
commands.

## Validate before changing GitHub

Run:

```bash
./restore-fleet.sh --check
./restore-fleet.sh --dry-run
```

The check verifies macOS/arm64, the bundled runner checksum, the manifest, the
manager scripts, and disk headroom. The dry run prints every planned runner
directory without registering runners or installing services.

## Install a new fleet

For a fleet whose names do not already exist on GitHub:

```bash
./restore-fleet.sh
```

The script prompts without echoing for one registration token per token key,
registers every target group, provisions tools, installs launchd services, and
waits for every runner to report `Listening for Jobs`.

Prompted entry is recommended because the token is never written to disk or
shell history. For unattended setup, provide variables derived from the token
keys:

```bash
MY_ORG_RUNNER_REGISTRATION_TOKEN='short-lived-token' \
MY_REPO_RUNNER_REGISTRATION_TOKEN='short-lived-token' \
  ./restore-fleet.sh
```

Do not save those variables in `.env`, `fleet.tsv`, shell profiles, or Git.

## Move existing runners to a new Mac

1. Prepare and dry-run the new Mac using the steps above.
2. Wait for all jobs on the old Mac to finish.
3. From the old runner-kit directory, stop every tracked runner:

   ```bash
   while IFS=$'\t' read -r name runner_dir; do
     ./manage-runners.sh stop "$name"
   done < runners.tsv
   ```

4. On the new Mac, reuse the same names with explicit replacement:

   ```bash
   ./restore-fleet.sh --replace-existing
   ```

5. Verify all runners and run a representative workflow before deleting the
   old runner directories.

`--replace-existing` invalidates the old registrations. A rollback therefore
requires fresh tokens to register the old directories again. Keep the old
directories until the new fleet is proven.

If you prefer not to replace registrations, delete the stopped runners in
GitHub settings first and run `./restore-fleet.sh` without the replacement
flag.

## Choose where runner directories live

By default, runner directories are created beside the kit directory. For
example, `actions-runner` plus runner `mac-arm64-1` produces
`actions-runner-mac-arm64-1`.

Set an absolute prefix before the first registration to choose another
location:

```bash
RUNNER_DIRECTORY_PREFIX='/Volumes/CI/actions-runner' ./restore-fleet.sh
```

Do not move the kit or runner directories after registration. If they must
move, stop and re-register them so launchd and `runners.tsv` contain the new
absolute paths.

## Verify and operate runners

List and inspect runners:

```bash
./runnerctl --cli list
./runnerctl --cli status mac-arm64-1
```

Open the interactive dashboard:

```bash
./runnerctl
```

The dashboard refreshes every five seconds. Useful direct commands are:

```bash
./manage-runners.sh start mac-arm64-1
./manage-runners.sh stop mac-arm64-1
./manage-runners.sh status mac-arm64-1
./manage-runners.sh reconcile mac-arm64-1
./manage-runners.sh reconcile-all
```

After setup, confirm each runner is idle/online in GitHub settings and run a
representative workflow for every GitHub target.

## Add a single runner without a fleet manifest

```bash
./bootstrap.sh \
  --url https://github.com/my-organization \
  mac-arm64-3
```

The script securely prompts for the registration token. Use
`--replace-existing` only when deliberately moving a same-name runner.

## Security model

The root `.gitignore` ignores everything by default and allowlists only source
files. In particular, Git never tracks:

- `.credentials`, `.credentials_rsaparams`, `.runner`, `.env`, or `.path`
- `runners.tsv` or the local `fleet.tsv`
- `_work`, `_diag`, downloaded tools, runner binaries, or archives
- Signing certificates, provisioning profiles, private keys, or packages

Before committing or publishing changes, run:

```bash
./security-audit.sh
git diff --cached --check
git status --short
```

The audit checks tracked paths and blobs for runner state, credential-bearing
file types, private keys, common GitHub/AWS/Slack/Stripe token formats, and the
current machine's home path. It reports filenames rather than printing
matching secret values.

GitHub Actions stores generated runner credentials inside each registered
runner directory. Those files are machine state, not portable configuration.
Always register fresh runners on the destination machine.

## Build a transfer archive

After `./prepare.sh` and after customizing `fleet.tsv`:

```bash
./build-portable-package.sh
```

For a generic distributable that contains the placeholder manifest:

```bash
RUNNER_FLEET_PATH='./fleet.example.tsv' \
  ./build-portable-package.sh
```

The builder:

1. Verifies the official runner archive checksum.
2. Includes only the manager, dashboard, overlay, README, and selected fleet
   manifest.
3. Creates an empty runtime `runners.tsv`.
4. Rejects live credentials, registrations, workspaces, logs, environment
   files, host-downloaded tools, and source-home paths.
5. Writes a `.tar.gz` and matching `.sha256` under `dist/`.

## Test

```bash
for test_script in tests/*.sh; do
  /bin/bash "$test_script"
done
npm test --prefix runnerctl-app
./security-audit.sh
```

## Troubleshooting

- **Runner archive missing:** run `./prepare.sh`.
- **Manifest still contains `CHANGE_ME`:** edit `fleet.tsv`.
- **Registration token rejected:** generate a fresh token for the exact
  organization or repository URL in that row.
- **Runner name already exists:** stop the old runner and deliberately use
  `--replace-existing`, or delete the old GitHub registration.
- **Service starts but runner stays offline:** inspect
  `<runner-directory>/_diag/Runner_*.log`.
- **Dashboard cannot find Node.js:** keep the bundled runner archive beside
  `runnerctl`; it extracts the runner's embedded Node executable when needed.
- **Insufficient disk:** clean old `_work` and tool caches or move the runner
  prefix to a larger volume before registration.
- **Apple build commands missing:** install/select full Xcode, accept its
  license, and install CocoaPods before running Apple build workflows.
