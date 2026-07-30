#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RESTORE_PATH="${ROOT_DIR}/restore-fleet.sh"

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT

bootstrap_stub="${temp_dir}/bootstrap.sh"
fleet_path="${temp_dir}/fleet.tsv"
operations_log="${temp_dir}/operations.log"

cat > "${fleet_path}" <<'EOF'
# token-key	GitHub organization or repository URL	runner name
MY_ORG	https://github.com/example-org	mac-runner-1
MY_ORG	https://github.com/example-org	mac-runner-2
MY_REPO	https://github.com/example-user/example-repo	repo-runner-1
EOF

cat > "${bootstrap_stub}" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\t%s\n' "${RUNNER_REGISTRATION_TOKEN:-}" "$*" >> "${RUNNER_TEST_OPERATIONS_LOG:?}"
EOF
chmod +x "${bootstrap_stub}"

restore_output="$(
  MY_ORG_RUNNER_REGISTRATION_TOKEN="org-smoke-token" \
  MY_REPO_RUNNER_REGISTRATION_TOKEN="repo-smoke-token" \
  RUNNER_BOOTSTRAP_PATH="${bootstrap_stub}" \
  RUNNER_FLEET_PATH="${fleet_path}" \
  RUNNER_TEST_OPERATIONS_LOG="${operations_log}" \
    "${RESTORE_PATH}" --replace-existing --no-start
)"

[ "$(wc -l < "${operations_log}" | tr -d ' ')" -eq 2 ]
grep -Fq $'org-smoke-token\t--url https://github.com/example-org --replace-existing --no-start mac-runner-1 mac-runner-2' "${operations_log}"
grep -Fq $'repo-smoke-token\t--url https://github.com/example-user/example-repo --replace-existing --no-start repo-runner-1' "${operations_log}"

if printf '%s\n' "${restore_output}" | grep -Fq "smoke-token"; then
  echo "restore output exposed a registration token"
  exit 1
fi

grep -Fq "fleet restore complete" <<< "${restore_output}"

placeholder_fleet="${temp_dir}/placeholder.tsv"
cp "${ROOT_DIR}/fleet.example.tsv" "${placeholder_fleet}"
if RUNNER_BOOTSTRAP_PATH="${bootstrap_stub}" \
  RUNNER_FLEET_PATH="${placeholder_fleet}" \
  RUNNER_TEST_OPERATIONS_LOG="${operations_log}" \
  "${RESTORE_PATH}" --dry-run >/dev/null 2>"${temp_dir}/placeholder.err"; then
  echo "expected placeholder fleet to be rejected"
  exit 1
fi
grep -Fq "still contains CHANGE_ME" "${temp_dir}/placeholder.err"
