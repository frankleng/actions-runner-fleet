#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AUDIT_PATH="${ROOT_DIR}/security-audit.sh"
DASHBOARD_PATH="${ROOT_DIR}/runnerctl-app/bin/runnerctl-dashboard.mjs"

grep -Fq 'promptInput(`${scope} registration token`, "", { secret: true })' "${DASHBOARD_PATH}"
grep -Fq 'censor: secret' "${DASHBOARD_PATH}"

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT

cp "${AUDIT_PATH}" "${temp_dir}/security-audit.sh"
chmod +x "${temp_dir}/security-audit.sh"

(
  cd "${temp_dir}"
  git init -q -b main
  printf '%s\n' "safe source" > source.txt
  git add security-audit.sh source.txt
  ./security-audit.sh >/dev/null

  printf '%s\n' '{}' > autoscale.json
  git add autoscale.json
  if ./security-audit.sh >audit.err 2>&1; then
    echo "expected security audit to reject local autoscaler configuration"
    exit 1
  fi
  grep -Fq "machine-local or credential-bearing path" audit.err
  git rm --cached -q autoscale.json
  printf '%s\n' '{}' > .autoscale-inflight.json
  git add .autoscale-inflight.json
  if ./security-audit.sh >audit.err 2>&1; then
    echo "expected security audit to reject ephemeral credentials"
    exit 1
  fi
  grep -Fq "machine-local or credential-bearing path" audit.err
  git rm --cached -q .autoscale-inflight.json

  {
    printf '%s\n' "# intentionally fake credential-shaped test data"
    printf '%s%s\n' 'github_pat_' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  } > credential-shaped.txt
  git add credential-shaped.txt

  if ./security-audit.sh >audit.err 2>&1; then
    echo "expected security audit to reject credential-shaped content"
    exit 1
  fi
  grep -Fq "potential credential format found" audit.err
)
