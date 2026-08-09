#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OVERLAY_DIR="${ROOT_DIR}/overlay"

temp_dir="$(mktemp -d)"
temp_user_home="${temp_dir}/launchd-user"
runner_dir="${temp_dir}/runner"
launchctl_stub="${temp_dir}/launchctl"
pgrep_stub="${temp_dir}/pgrep"
pkill_stub="${temp_dir}/pkill"
pgrep_log="${temp_dir}/pgrep.log"
pkill_log="${temp_dir}/pkill.log"
process_state="${temp_dir}/process.state"
trap 'rm -rf "${temp_dir}"' EXIT

mkdir -p "${runner_dir}/bin" "${runner_dir}/externals/node20/bin" "${temp_user_home}"
mkdir -p "${temp_dir}/host-tools/pnpm-tools/bin"
cat > "${temp_dir}/host-tools/pnpm-tools/bin/wrangler" <<'EOF'
#!/bin/sh
printf '4.69.0\n'
EOF
chmod u+x "${temp_dir}/host-tools/pnpm-tools/bin/wrangler"
runner_dir="$(cd "${runner_dir}" && pwd -P)"
temp_user_home="$(cd "${temp_user_home}" && pwd -P)"

cat > "${runner_dir}/.runner" <<'EOF'
{
  "agentName": "smoke-runner",
  "gitHubUrl": "https://github.com/example-org"
}
EOF

cp "${OVERLAY_DIR}/env.sh" "${runner_dir}/env.sh"
cp "${OVERLAY_DIR}/svc.sh" "${runner_dir}/svc.sh"
cp "${OVERLAY_DIR}/runsvc.sh" "${runner_dir}/bin/runsvc.sh"
cp "${OVERLAY_DIR}/bin/actions.runner.plist.template" "${runner_dir}/bin/actions.runner.plist.template"
chmod +x "${runner_dir}/env.sh" "${runner_dir}/svc.sh" "${runner_dir}/bin/runsvc.sh"

cat > "${runner_dir}/externals/node20/bin/node" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "${runner_dir}/externals/node20/bin/node"

cat > "${launchctl_stub}" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "${launchctl_stub}"

cat > "${pgrep_stub}" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "${RUNNER_TEST_PGREP_LOG:?}"
if [ -s "${RUNNER_TEST_PROCESS_STATE:?}" ]; then
  cat "${RUNNER_TEST_PROCESS_STATE}"
fi
EOF
chmod +x "${pgrep_stub}"

cat > "${pkill_stub}" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "${RUNNER_TEST_PKILL_LOG:?}"
if [ -f "${RUNNER_TEST_PROCESS_STATE:?}" ]; then
  : > "${RUNNER_TEST_PROCESS_STATE}"
fi
EOF
chmod +x "${pkill_stub}"

(
  cd "${runner_dir}"
  RUNNER_PROVISION_SCRIPT_PATH="${ROOT_DIR}/provision-runner-tooling.sh" \
  RUNNER_HOST_TOOLS_DIR="${temp_dir}/host-tools" \
  RUNNER_PNPM_STORE_DIR="${temp_dir}/pnpm-store" \
  ./env.sh
  RUNNER_PROVISION_SCRIPT_PATH="${ROOT_DIR}/provision-runner-tooling.sh" \
  RUNNER_HOST_TOOLS_DIR="${temp_dir}/host-tools" \
  RUNNER_PNPM_STORE_DIR="${temp_dir}/pnpm-store" \
  RUNNER_LAUNCHD_USER_HOME="${temp_user_home}" \
  RUNNER_LAUNCH_PATH="${temp_user_home}/Library/LaunchAgents" \
  RUNNER_LAUNCHCTL_BIN="${launchctl_stub}" \
  ./svc.sh install
)

plist_path="${temp_user_home}/Library/LaunchAgents/actions.runner.example-org.smoke-runner.plist"

grep -q "<key>HOME</key>" "${plist_path}"
grep -q "<string>${runner_dir}/home</string>" "${plist_path}"
grep -q "<key>TMPDIR</key>" "${plist_path}"
grep -q "<string>${runner_dir}/tmp</string>" "${plist_path}"
grep -q "${runner_dir}/home/Library/Logs/actions.runner.example-org.smoke-runner/stdout.log" "${plist_path}"
grep -q "${runner_dir}/home/Library/Logs/actions.runner.example-org.smoke-runner/stderr.log" "${plist_path}"
grep -q '\.env' "${runner_dir}/runsvc.sh"
grep -q '\.path' "${runner_dir}/runsvc.sh"

log_dir="${runner_dir}/home/Library/Logs/actions.runner.example-org.smoke-runner"
diag_dir="${runner_dir}/_diag"
mkdir -p "${log_dir}" "${diag_dir}/blocks" "${diag_dir}/pages"

printf 'this line should rotate due to size threshold\n' > "${log_dir}/stdout.log"
printf 'stderr should stay below threshold\n' > "${log_dir}/stderr.log"
printf 'old rotated entry\n' > "${log_dir}/stdout.log.20250101-000000"
printf 'old runner log\n' > "${diag_dir}/Runner_20250101-000000-utc.log"
printf 'old worker log\n' > "${diag_dir}/Worker_20250101-000000-utc.log"
printf 'old block\n' > "${diag_dir}/blocks/old.block"
printf 'old page\n' > "${diag_dir}/pages/old.page"
printf 'new runner log\n' > "${diag_dir}/Runner_recent.log"
printf 'new block\n' > "${diag_dir}/blocks/recent.block"

touch -t 202501010000 "${log_dir}/stdout.log.20250101-000000"
touch -t 202501010000 "${diag_dir}/Runner_20250101-000000-utc.log"
touch -t 202501010000 "${diag_dir}/Worker_20250101-000000-utc.log"
touch -t 202501010000 "${diag_dir}/blocks/old.block"
touch -t 202501010000 "${diag_dir}/pages/old.page"

(
  cd "${runner_dir}"
  RUNNER_LOG_RETENTION_DAYS=7 \
  RUNNER_LOG_ROTATE_MAX_BYTES=10 \
  ./svc.sh prune-logs
)

[ -f "${log_dir}/stdout.log" ]
[ "$(wc -c < "${log_dir}/stdout.log")" -eq 0 ]
[ ! -f "${log_dir}/stdout.log.20250101-000000" ]
[ ! -f "${diag_dir}/Runner_20250101-000000-utc.log" ]
[ ! -f "${diag_dir}/Worker_20250101-000000-utc.log" ]
[ ! -f "${diag_dir}/blocks/old.block" ]
[ ! -f "${diag_dir}/pages/old.page" ]
[ -f "${diag_dir}/Runner_recent.log" ]
[ -f "${diag_dir}/blocks/recent.block" ]

rotated_stdout_count="$(find "${log_dir}" -maxdepth 1 -type f -name 'stdout.log.*' | wc -l | tr -d ' ')"
[ "${rotated_stdout_count}" -ge 1 ]

printf '%s\n' "2001" > "${process_state}"

(
  cd "${runner_dir}"
  RUNNER_LAUNCHD_USER_HOME="${temp_user_home}" \
  RUNNER_LAUNCH_PATH="${temp_user_home}/Library/LaunchAgents" \
  RUNNER_LAUNCHCTL_BIN="${launchctl_stub}" \
  RUNNER_PGREP_BIN="${pgrep_stub}" \
  RUNNER_PKILL_BIN="${pkill_stub}" \
  RUNNER_TEST_PGREP_LOG="${pgrep_log}" \
  RUNNER_TEST_PKILL_LOG="${pkill_log}" \
  RUNNER_TEST_PROCESS_STATE="${process_state}" \
  ./svc.sh stop
)

[ ! -s "${process_state}" ]
grep -Fq "Runner\\.Listener" "${pgrep_log}"
grep -Fq "Runner\\.Listener" "${pkill_log}"
