# Security Audit Report

Audit date: 2026-07-29

> Post-audit update: the repository and its releases are now public. Statements
> about private visibility and the audit-time file or commit count are
> historical evidence; the credential and hardening findings are unchanged.

## Executive verdict

No private credential was found in the tracked `actions-runner-fleet` tree, its
reachable Git history, or the published `v1.0.0` release archive.

The repository should not yet be treated as hardened for untrusted workflows.
It provisions a vulnerable pnpm release, provisions a Node.js release that
predates multiple high-severity security fixes, downloads executable Node.js
and Pulumi archives without integrity verification, and uses persistent runner
workspaces without an isolation or cleanup boundary.

One urgent credential issue was found outside the target Git repository: an
ignored, persisted `_work/.../preferences.arc` file from another checkout
contains two non-placeholder Slack webhook URLs. Gitleaks independently
classified both as `slack-webhook-url`. The containing historical commit is
still reachable in that other private repository's remote history. The values
are intentionally omitted from this report and were not tested. Rotate both
webhooks and treat their historical copies as disclosed.

## Scope and evidence

The audit covered:

- All 27 tracked files and the sole reachable commit.
- All 22 unreachable local Git blobs. No credential pattern was present in
  them. Some contain old machine paths and deployment names, so transfer the
  release archive or make a fresh clone rather than copying this checkout's
  `.git` directory.
- Ignored local runtime state, diagnostics, and workspaces using filename-only
  and redacted secret scans.
- A fresh authenticated download of the private `v1.0.0` release.
- Shell and JavaScript command, input, download, extraction, and credential
  flows.
- npm dependencies and upstream security advisories for shell-provisioned
  tools.
- Current GitHub repository security settings.

Independent checks:

- Gitleaks 8.30.1, downloaded from its official release and checksum-verified:
  zero findings in reachable Git history and zero findings in the extracted
  release.
- Release SHA-256:
  `2288cbbb1afc334398ec82532096db7b70044234837f5b69ac7af66aa994db7b`.
  The downloaded asset matches both its companion checksum file and GitHub's
  asset digest.
- The release has zero runner-state paths, uses the placeholder fleet manifest,
  has an empty `runners.tsv`, and contains no source-machine home path or
  deployment-specific names.
- `npm audit --omit=dev`: zero known vulnerabilities in the dashboard's locked
  dependency graph.
- The bundled `blessed@0.1.81` directory is byte-for-byte identical to a clean
  `npm ci --ignore-scripts` install and its lockfile integrity matches the npm
  registry.
- The private remote has no repository Actions secrets or variables. Dependabot
  alerts and automated security fixes are enabled with zero current alerts.

## Findings

### ARF-001 — High — Persistent runners retain secrets and untrusted state

Evidence:

- `manage-runners.sh:137-145` creates durable runner home, work, temporary, and
  tool-cache directories.
- Registration at `manage-runners.sh:337-348` does not use `--ephemeral`.
- The README describes generated runner credentials at `README.md:260-262`, but
  does not restrict the fleet to trusted workflows or require cleanup between
  jobs.
- The ignored live `_work` tree contains two real-looking Slack webhooks from a
  different checkout. They are excluded from this repository and release, but
  demonstrate that job material is persisting on the host.

Impact:

A workflow can read artifacts, credentials, configuration, or malicious
modifications left by an earlier job. A compromised job can also persist code
for later jobs. GitHub recommends ephemeral self-hosted runners because a clean
environment limits exposure from previous jobs and reduces the chance that a
compromised runner receives another job:
[GitHub self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#ephemeral-runners-for-autoscaling).

Recommendation:

Use these persistent runners only for tightly controlled private repositories
and trusted branches. Do not route public-fork or otherwise untrusted pull
requests to them. Prefer one-job ephemeral runners with host teardown, or add a
fail-closed cleanup/reimage boundary that removes workspaces, temporary files,
tool state, and credentials after every job. Document the trust boundary in the
README.

### ARF-002 — High — Provisioned pnpm 9.4.0 has known high-severity vulnerabilities

Evidence:

- `provision-runner-tooling.sh:19` pins `PNPM_VERSION="9.4.0"`.
- `provision-runner-tooling.sh:237-248` installs that version for every runner.
- GitHub's reviewed advisory database marks pnpm 9.4.0 as affected by multiple
  later advisories. Examples include command injection in CI environments
  ([GHSA-2phv-j68v-wwqx](https://github.com/advisories/GHSA-2phv-j68v-wwqx))
  and repository-selected registry credential disclosure
  ([GHSA-cjhr-43r9-cfmw](https://github.com/advisories/GHSA-cjhr-43r9-cfmw)).

Impact:

Repository-controlled package-manager inputs can trigger command execution,
path manipulation, integrity bypasses, or credential disclosure in a CI
environment. The dashboard's clean `npm audit` result does not cover this tool
because pnpm is installed dynamically by a shell script rather than declared in
the dashboard lockfile.

Recommendation:

Move to a maintained, fully patched pnpm line and pin the exact package
integrity. At the audit date, all reviewed advisories should be checked against
the selected release; do not assume that a single minimum version covers later
advisories. Reprovision every existing runner after updating the pin.

### ARF-003 — High — Node.js 22.21.1 predates high-severity security fixes

Evidence:

- `provision-runner-tooling.sh:18` pins Node.js 22.21.1.
- `provision-runner-tooling.sh:209-234` installs it into each runner tool cache.
- Node.js 22.22.0 was a security release, and Node.js 22.23.0 fixed additional
  high-severity issues in June 2026. The follow-up 22.23.1 release is available
  for macOS arm64:
  [June 2026 security release](https://nodejs.org/en/blog/vulnerability/june-2026-security-releases),
  [Node.js 22.23.1](https://nodejs.org/en/blog/release/v22.23.1).

Impact:

Jobs execute a Node.js build with known high-severity vulnerabilities,
including TLS, WebCrypto, HTTP, and dependency-level issues fixed after
22.21.1.

Recommendation:

Upgrade the Node.js 22 pin to a current supported security release, pin its
published SHA-256, and reprovision all runners. Add a scheduled review for
shell-pinned runtime versions because Dependabot does not track them.

### ARF-004 — High — Node.js and Pulumi downloads are executed without integrity verification

Evidence:

- `provision-runner-tooling.sh:216-220` downloads and extracts Node.js without a
  checksum or signature check.
- `provision-runner-tooling.sh:286-290` does the same for Pulumi.
- The AWS path correctly verifies the expected Apple installer identity at
  `provision-runner-tooling.sh:332-337`, showing the intended fail-closed model.
- Node.js publishes signed `SHASUMS256` files for the exact release, and Pulumi
  publishes per-release checksums:
  [Node.js 22.21.1 release files](https://nodejs.org/download/release/v22.21.1/),
  [Pulumi CLI versions and checksums](https://www.pulumi.com/docs/install/versions/).

Impact:

A compromised download endpoint, proxy, DNS path, or upstream artifact can
place attacker-controlled executables on every runner. HTTPS and a versioned
URL do not provide an independent artifact identity check.

Recommendation:

Pin SHA-256 values in source, download to a temporary file, verify before
extraction, and fail closed. Prefer verifying upstream signatures as well.
Apply the same policy to every executable archive.

### ARF-005 — Medium — Direct management paths bypass the pinned runner checksum

Evidence:

- `bootstrap.sh:72-78` correctly verifies the runner archive.
- `manage-runners.sh:322-348` accepts any archive at `RUNNER_ARCHIVE_PATH`,
  extracts it, and runs its `config.sh` without checking the pinned digest.
- The dashboard invokes `manage-runners.sh` directly at
  `runnerctl-app/bin/runnerctl-dashboard.mjs:321-326` and `:372-376`.
- `runnerctl:22-35` also extracts and executes the archive's embedded Node.js
  without a checksum check.

Impact:

The safe bootstrap path is not a universal trust boundary. A corrupted,
substituted, or user-supplied archive can be executed through the dashboard or
direct manager commands.

Recommendation:

Move archive verification into one shared helper and require it immediately
before every extraction or execution path. Reject version/path overrides unless
an explicit matching digest is provided.

### ARF-006 — Medium — Release builds copy ignored local `node_modules`

Evidence:

- `build-portable-package.sh:48` copies the checkout's ignored
  `runnerctl-app/node_modules` directly into a release.
- The current release is clean and matches a fresh locked install, but the
  builder does not establish that invariant itself.

Impact:

Locally modified, stale, or malicious dependency files can be published even
when `package-lock.json` is correct.

Recommendation:

Run `npm ci --ignore-scripts` in a clean temporary staging directory and package
that result. Compare the installed dependency tree to the lockfile before
creating the archive.

### ARF-007 — Low — Registration tokens cross process argument lists

Evidence:

- `manage-runners.sh:24` exposes `register <name> <token> <url>` as a CLI.
- `bootstrap.sh:282-286` and the dashboard registration path pass the token as a
  positional process argument.
- `manage-runners.sh:337-348` then passes it to the official `config.sh`.

Impact:

The token is not written to disk or shell history, but it may be visible for a
short time to local process-inspection tools. Registration tokens are
short-lived, which limits but does not remove the risk.

Recommendation:

Remove the token from the public manager CLI and pass it over a protected file
descriptor or standard input until the final runner configuration boundary.
Document that the official configuration process still receives a short-lived
token and keep the exposure window minimal.

### ARF-008 — Low — The built-in secret check is narrow and manual

Evidence:

- `security-audit.sh:16-41` scans only the current index, a short list of token
  patterns, and the current home path.
- It does not scan reachable history, dangling objects, release assets,
  high-entropy generic secrets, or provider patterns outside its list.
- No workflow or enforced hook runs the audit before a push or release.

Impact:

The current repository is clean, but a deleted historical secret or an
unsupported credential format can pass the script. The success message can be
read as broader assurance than the script provides.

Recommendation:

Keep the fast allowlist check, add a maintained scanner such as Gitleaks for
history and release staging, and enforce both on a GitHub-hosted runner before
release. Keep output redacted.

### ARF-009 — Low — GitHub protections are minimal

Evidence:

- The repository is private.
- `main` has no classic branch protection and no repository ruleset.
- Secret scanning and code scanning are unavailable or disabled for this
  user-owned private repository.
- Dependabot alerts and automated security fixes are enabled, with zero current
  alerts.

Impact:

There is no server-side guard against accidental force-pushes, direct changes,
or future credential commits. Local checks remain the primary protection.

Recommendation:

Add a `main` ruleset or branch protection if the account plan supports it.
Enable GitHub Secret Protection if the ownership and plan become eligible:
[GitHub secret scanning availability](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/detect-secret-leaks/enable-secret-scanning).
Until then, enforce redacted local/history scanning and preserve the default-deny
`.gitignore`.

## Positive controls

- `.gitignore:1-33` uses a default-deny model and explicitly allowlists source.
- Runner credentials, metadata, workspaces, logs, archives, local manifests,
  downloaded tools, signing material, and packages are untracked.
- `prepare.sh:48-53`, `bootstrap.sh:72-78`, and
  `build-portable-package.sh:21-28` verify the pinned official Actions runner
  archive. Actions runner 2.336.0 was the current upstream release at audit
  time.
- `build-portable-package.sh:64-78` rejects live runner state, source-home paths,
  and common credential formats before packaging.
- The dashboard masks registration-token input at
  `runnerctl-app/bin/runnerctl-dashboard.mjs:422-429`.
- Shell arguments are generally quoted, subprocesses avoid shell interpolation,
  runner names and GitHub URLs are validated on the documented bootstrap/fleet
  paths, and no tracked file is world-writable.
- Existing runner RSA parameter files are mode `0600`. The mode `0644`
  `.credentials` files contain only an authorization URL, client identifier,
  and FIPS flag; no private key material was found in them.

## Remediation order

1. Rotate the two adjacent Slack webhooks and inspect the other repository's
   reachable history and downstream consumers.
2. Upgrade pnpm and Node.js, pin their integrity, and reprovision all runners.
3. Add integrity checks for Pulumi and every runner archive execution path.
4. Decide and document the runner trust boundary; prefer ephemeral runners or a
   reliable per-job teardown.
5. Make release dependency installation reproducible.
6. Add enforced history/release secret scanning and repository protections.

No remediation was applied as part of this audit.
