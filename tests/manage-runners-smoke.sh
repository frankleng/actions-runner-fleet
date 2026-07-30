#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/runnerctl"

help_output="$("${SCRIPT_PATH}" --cli help 2>&1 || true)"
printf '%s\n' "${help_output}" | grep -q "register"
printf '%s\n' "${help_output}" | grep -q "reconcile"
printf '%s\n' "${help_output}" | grep -q "reconcile-all"
printf '%s\n' "${help_output}" | grep -q "track"
printf '%s\n' "${help_output}" | grep -q "list"

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT

registry_path="${temp_dir}/runners.tsv"
archive_root="${temp_dir}/archive-root"
archive_dir="${archive_root}/template"
archive_path="${temp_dir}/runner.tar.gz"
launchctl_log="${temp_dir}/launchctl.log"
launchctl_state="${temp_dir}/launchctl.state"
launchctl_stub="${temp_dir}/launchctl"
provision_log="${temp_dir}/provision.log"
provision_stub="${temp_dir}/provision-runner-tooling.sh"
pgrep_log="${temp_dir}/pgrep.log"
pkill_log="${temp_dir}/pkill.log"
process_state="${temp_dir}/process.state"
config_log="${temp_dir}/config.log"
pgrep_stub="${temp_dir}/pgrep"
pkill_stub="${temp_dir}/pkill"
runner_dir="${temp_dir}/mac-runner-1"
runner_dir_2="${temp_dir}/mac-runner-2"
mkdir -p "${runner_dir}" "${runner_dir_2}" "${archive_dir}/bin" "${archive_dir}/externals/node20/bin"

cat > "${launchctl_stub}" <<'EOF'
#!/bin/bash
set -euo pipefail
log_path="${RUNNER_TEST_LAUNCHCTL_LOG:?}"
state_path="${RUNNER_TEST_LAUNCHCTL_STATE:?}"
command="${1:-}"
shift || true
case "${command}" in
  load)
    if [ "${1:-}" = "-w" ]; then
      shift
    fi
    plist_path="${1:?}"
    svc_name="$(basename "${plist_path}" .plist)"
    printf '%s\n' "${svc_name}" >> "${state_path}"
    printf 'load %s\n' "${svc_name}" >> "${log_path}"
    ;;
  unload)
    plist_path="${1:?}"
    svc_name="$(basename "${plist_path}" .plist)"
    if [ -f "${state_path}" ]; then
      grep -vx "${svc_name}" "${state_path}" > "${state_path}.tmp" || true
      mv "${state_path}.tmp" "${state_path}"
    fi
    printf 'unload %s\n' "${svc_name}" >> "${log_path}"
    ;;
  list)
    if [ -f "${state_path}" ]; then
      while IFS= read -r svc_name; do
        [ -n "${svc_name}" ] || continue
        printf '123\t0\t%s\n' "${svc_name}"
      done < "${state_path}"
    fi
    ;;
  *)
    printf 'unexpected launchctl command: %s\n' "${command}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "${launchctl_stub}"

cat > "${provision_stub}" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "${RUNNER_TEST_PROVISION_LOG:?}"
EOF
chmod +x "${provision_stub}"

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

cat > "${archive_dir}/config.sh" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "${RUNNER_TEST_CONFIG_LOG:?}"
name=""
url=""
work=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --name)
      name="$2"
      shift 2
      ;;
    --url)
      url="$2"
      shift 2
      ;;
    --work)
      work="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
cat > .runner <<JSON
{
  "agentName": "${name}",
  "gitHubUrl": "${url}",
  "workFolder": "${work}"
}
JSON
EOF
chmod +x "${archive_dir}/config.sh"

cat > "${archive_dir}/run.sh" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "${archive_dir}/run.sh"

cat > "${archive_dir}/externals/node20/bin/node" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "${archive_dir}/externals/node20/bin/node"

tar -czf "${archive_path}" -C "${archive_dir}" .

RUNNER_REGISTRY_PATH="${registry_path}" "${SCRIPT_PATH}" --cli track "mac-runner-1" "${runner_dir}"
RUNNER_REGISTRY_PATH="${registry_path}" "${SCRIPT_PATH}" --cli track "mac-runner-2" "${runner_dir_2}"

list_output="$(RUNNER_REGISTRY_PATH="${registry_path}" "${SCRIPT_PATH}" --cli list)"
printf '%s\n' "${list_output}" | grep -q "mac-runner-1"
printf '%s\n' "${list_output}" | grep -q "${runner_dir}"
printf '%s\n' "${list_output}" | grep -q "mac-runner-2"
printf '%s\n' "${list_output}" | grep -q "${runner_dir_2}"

if RUNNER_REGISTRY_PATH="${registry_path}" "${SCRIPT_PATH}" --cli track "mac-runner-1" "${runner_dir}" >/dev/null 2>"${temp_dir}/duplicate.err"; then
  echo "expected duplicate track to fail"
  exit 1
fi

grep -q "already tracked" "${temp_dir}/duplicate.err"

for managed_runner_dir in "${runner_dir}" "${runner_dir_2}"; do
  runner_name="$(basename "${managed_runner_dir}")"
  cat > "${managed_runner_dir}/.runner" <<EOF
{
  "agentName": "${runner_name}",
  "gitHubUrl": "https://github.com/example-org"
}
EOF
done

RUNNER_REGISTRY_PATH="${registry_path}" \
RUNNER_PROVISION_SCRIPT_PATH="${provision_stub}" \
RUNNER_LAUNCHD_USER_HOME="${temp_dir}/launchd-user" \
RUNNER_LAUNCH_PATH="${temp_dir}/launchd-user/Library/LaunchAgents" \
RUNNER_LAUNCHCTL_BIN="${launchctl_stub}" \
RUNNER_TEST_PROVISION_LOG="${provision_log}" \
RUNNER_TEST_LAUNCHCTL_LOG="${launchctl_log}" \
RUNNER_TEST_LAUNCHCTL_STATE="${launchctl_state}" \
"${SCRIPT_PATH}" --cli reconcile "mac-runner-1"

grep -q -- "--root ${runner_dir}" "${provision_log}"
[ -f "${runner_dir}/.env" ]
[ -f "${runner_dir}/.path" ]

: > "${provision_log}"
: > "${launchctl_log}"
: > "${launchctl_state}"

RUNNER_REGISTRY_PATH="${registry_path}" \
RUNNER_PROVISION_SCRIPT_PATH="${provision_stub}" \
RUNNER_ARCHIVE_PATH="${archive_path}" \
RUNNER_REPLACE_EXISTING=1 \
RUNNER_TEST_CONFIG_LOG="${config_log}" \
RUNNER_LAUNCHD_USER_HOME="${temp_dir}/launchd-user" \
RUNNER_LAUNCH_PATH="${temp_dir}/launchd-user/Library/LaunchAgents" \
RUNNER_LAUNCHCTL_BIN="${launchctl_stub}" \
RUNNER_TEST_PROVISION_LOG="${provision_log}" \
RUNNER_TEST_LAUNCHCTL_LOG="${launchctl_log}" \
RUNNER_TEST_LAUNCHCTL_STATE="${launchctl_state}" \
"${SCRIPT_PATH}" --cli register "mac-runner-registered" "token-123" "https://github.com/example-org" "${temp_dir}/mac-runner-registered"

grep -q -- "--root ${temp_dir}/mac-runner-registered" "${provision_log}"
grep -q -- "--replace" "${config_log}"
register_list_output="$(RUNNER_REGISTRY_PATH="${registry_path}" "${SCRIPT_PATH}" --cli list)"
printf '%s\n' "${register_list_output}" | grep -q "mac-runner-registered"

: > "${provision_log}"
: > "${launchctl_log}"
: > "${launchctl_state}"

RUNNER_REGISTRY_PATH="${registry_path}" \
RUNNER_PROVISION_SCRIPT_PATH="${provision_stub}" \
RUNNER_ARCHIVE_PATH="${archive_path}" \
RUNNER_DEFER_RECONCILE=1 \
RUNNER_TEST_CONFIG_LOG="${config_log}" \
"${SCRIPT_PATH}" --cli register \
  "repo-runner-deferred" \
  "token-456" \
  "https://github.com/example-user/example-repo" \
  "${temp_dir}/repo-runner-deferred"

[ -f "${temp_dir}/repo-runner-deferred/.runner" ]
[ ! -s "${provision_log}" ]
deferred_list_output="$(RUNNER_REGISTRY_PATH="${registry_path}" "${SCRIPT_PATH}" --cli list)"
printf '%s\n' "${deferred_list_output}" | grep -q "repo-runner-deferred"

RUNNER_REGISTRY_PATH="${registry_path}" \
RUNNER_PROVISION_SCRIPT_PATH="${provision_stub}" \
RUNNER_LAUNCHD_USER_HOME="${temp_dir}/launchd-user" \
RUNNER_LAUNCH_PATH="${temp_dir}/launchd-user/Library/LaunchAgents" \
RUNNER_LAUNCHCTL_BIN="${launchctl_stub}" \
RUNNER_TEST_PROVISION_LOG="${provision_log}" \
RUNNER_TEST_LAUNCHCTL_LOG="${launchctl_log}" \
RUNNER_TEST_LAUNCHCTL_STATE="${launchctl_state}" \
"${SCRIPT_PATH}" --cli reconcile-all

grep -q -- "--root ${runner_dir}" "${provision_log}"
grep -q -- "--root ${runner_dir_2}" "${provision_log}"
grep -q -- "--root ${temp_dir}/repo-runner-deferred" "${provision_log}"
grep -q "load actions.runner.example-org.mac-runner-1" "${launchctl_log}"
grep -q "load actions.runner.example-org.mac-runner-2" "${launchctl_log}"
grep -q "load actions.runner.example-repo.repo-runner-deferred" "${launchctl_log}"

: > "${pgrep_log}"
: > "${pkill_log}"
printf '%s\n' "1001" > "${process_state}"

RUNNER_REGISTRY_PATH="${registry_path}" \
RUNNER_PROVISION_SCRIPT_PATH="${provision_stub}" \
RUNNER_LAUNCHD_USER_HOME="${temp_dir}/launchd-user" \
RUNNER_LAUNCH_PATH="${temp_dir}/launchd-user/Library/LaunchAgents" \
RUNNER_LAUNCHCTL_BIN="${launchctl_stub}" \
RUNNER_TEST_PROVISION_LOG="${provision_log}" \
RUNNER_TEST_LAUNCHCTL_LOG="${launchctl_log}" \
RUNNER_TEST_LAUNCHCTL_STATE="${launchctl_state}" \
RUNNER_PGREP_BIN="${pgrep_stub}" \
RUNNER_PKILL_BIN="${pkill_stub}" \
RUNNER_TEST_PGREP_LOG="${pgrep_log}" \
RUNNER_TEST_PKILL_LOG="${pkill_log}" \
RUNNER_TEST_PROCESS_STATE="${process_state}" \
"${SCRIPT_PATH}" --cli stop "mac-runner-1"

[ ! -s "${process_state}" ]
grep -Fq "Runner\\.Listener" "${pgrep_log}"
grep -Fq "Runner\\.Listener" "${pkill_log}"

bash "${ROOT_DIR}/tests/runner-service-generation-smoke.sh"
