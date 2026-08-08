#!/bin/bash

set -euo pipefail
export RUNNER_SERVICE_MANAGER_OVERRIDE=launchd

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BOOTSTRAP_PATH="${ROOT_DIR}/bootstrap.sh"

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT

help_output="$("${BOOTSTRAP_PATH}" --help)"
grep -Fq "repository, organization, or enterprise" <<< "${help_output}"
grep -Fq "https://github.com/enterprises/ENTERPRISE" <<< "${help_output}"
grep -Fq "defaults to organization scope" <<< "${help_output}"

registry_path="${temp_dir}/runners.tsv"
operations_log="${temp_dir}/operations.log"
manage_stub="${temp_dir}/manage-runners.sh"
launchctl_stub="${temp_dir}/launchctl"

cat > "${manage_stub}" <<'EOF'
#!/bin/bash

set -euo pipefail

registry_path="${RUNNER_REGISTRY_PATH:?}"
operations_log="${RUNNER_TEST_OPERATIONS_LOG:?}"
action="${1:?}"

  case "${action}" in
  register)
    [ "${RUNNER_DEFER_RECONCILE:-0}" = "1" ]
    [ "${RUNNER_REPLACE_EXISTING:-0}" = "1" ]
    runner_name="${2:?}"
    runner_url="${4:?}"
    runner_dir="${5:?}"
    mkdir -p "${runner_dir}"
    printf '{"agentName":"%s","gitHubUrl":"%s","workFolder":"_work"}\n' \
      "${runner_name}" "${runner_url}" > "${runner_dir}/.runner"
    printf '%s\t%s\n' "${runner_name}" "${runner_dir}" >> "${registry_path}"
    printf 'register %s\n' "${runner_name}" >> "${operations_log}"
    ;;
  start)
    runner_name="${2:?}"
    runner_dir="$(awk -F '\t' -v name="${runner_name}" '$1 == name { print $2; exit }' "${registry_path}")"
    mkdir -p "${runner_dir}/_diag"
    printf 'Listening for Jobs\n' > "${runner_dir}/_diag/Runner_smoke.log"
    printf 'start %s\n' "${runner_name}" >> "${operations_log}"
    ;;
  status)
    printf 'Stopped\n'
    ;;
  reconcile)
    printf 'reconcile %s\n' "${2:?}" >> "${operations_log}"
    ;;
  *)
    printf 'unexpected action: %s\n' "${action}" >&2
    exit 1
    ;;
esac
EOF
chmod u+x "${manage_stub}"

cat > "${launchctl_stub}" <<'EOF'
#!/bin/bash

set -euo pipefail

printf 'launchctl %s\n' "$*" >> "${RUNNER_TEST_OPERATIONS_LOG:?}"
EOF
chmod u+x "${launchctl_stub}"

default_layout_output="$(
  RUNNER_REGISTRY_PATH="${temp_dir}/default-layout-runners.tsv" \
  RUNNER_MANAGE_RUNNERS_PATH="${manage_stub}" \
  RUNNER_LAUNCHCTL_BIN="${launchctl_stub}" \
  RUNNER_DIRECTORY_PREFIX="" \
  RUNNER_TEST_OPERATIONS_LOG="${operations_log}" \
    "${BOOTSTRAP_PATH}" \
      --dry-run \
      --url https://github.com/example-org \
      default-layout-runner
)"
grep -Fq \
  "register: default-layout-runner -> ${ROOT_DIR}/.runners/default-layout-runner" \
  <<< "${default_layout_output}"

RUNNER_REGISTRATION_TOKEN="smoke-token" \
RUNNER_REGISTRY_PATH="${registry_path}" \
RUNNER_MANAGE_RUNNERS_PATH="${manage_stub}" \
RUNNER_LAUNCHCTL_BIN="${launchctl_stub}" \
RUNNER_DIRECTORY_PREFIX="${temp_dir}/actions-runner" \
RUNNER_TEST_OPERATIONS_LOG="${operations_log}" \
  "${BOOTSTRAP_PATH}" \
    --url https://github.com/example-org \
    --replace-existing \
    mac-runner-1 \
    mac-runner-2 \
    mac-runner-3 \
    mac-runner-4

[ "$(wc -l < "${registry_path}" | tr -d ' ')" -eq 4 ]
[ "$(grep -c '^register ' "${operations_log}")" -eq 4 ]
[ "$(grep -c '^start ' "${operations_log}")" -eq 4 ]
[ "$(grep -c '^launchctl enable ' "${operations_log}")" -eq 4 ]

last_register_line="$(grep -n '^register ' "${operations_log}" | tail -1 | cut -d: -f1)"
first_start_line="$(grep -n '^start ' "${operations_log}" | head -1 | cut -d: -f1)"
[ "${last_register_line}" -lt "${first_start_line}" ]

before_reregister_count="$(grep -c '^register ' "${operations_log}")"
RUNNER_REGISTRY_PATH="${registry_path}" \
RUNNER_MANAGE_RUNNERS_PATH="${manage_stub}" \
RUNNER_LAUNCHCTL_BIN="${launchctl_stub}" \
RUNNER_DIRECTORY_PREFIX="${temp_dir}/actions-runner" \
RUNNER_TEST_OPERATIONS_LOG="${operations_log}" \
  "${BOOTSTRAP_PATH}" \
    --url https://github.com/example-org \
    mac-runner-1 \
    mac-runner-2 \
    mac-runner-3 \
    mac-runner-4
after_reregister_count="$(grep -c '^register ' "${operations_log}")"

[ "${before_reregister_count}" -eq "${after_reregister_count}" ]

if RUNNER_DEFAULT_URL="" \
  RUNNER_REGISTRY_PATH="${temp_dir}/missing-url-runners.tsv" \
  RUNNER_MANAGE_RUNNERS_PATH="${manage_stub}" \
  RUNNER_LAUNCHCTL_BIN="${launchctl_stub}" \
  RUNNER_DIRECTORY_PREFIX="${temp_dir}/actions-runner" \
  RUNNER_TEST_OPERATIONS_LOG="${operations_log}" \
  "${BOOTSTRAP_PATH}" --dry-run mac-runner-missing-url \
  >/dev/null 2>"${temp_dir}/missing-url.err"; then
  echo "expected bootstrap without a GitHub URL to fail"
  exit 1
fi
grep -Fq -- "--url is required" "${temp_dir}/missing-url.err"

enterprise_output="$(
  RUNNER_REGISTRY_PATH="${temp_dir}/enterprise-runners.tsv" \
  RUNNER_MANAGE_RUNNERS_PATH="${manage_stub}" \
  RUNNER_LAUNCHCTL_BIN="${launchctl_stub}" \
  RUNNER_DIRECTORY_PREFIX="${temp_dir}/actions-runner" \
  RUNNER_TEST_OPERATIONS_LOG="${operations_log}" \
    "${BOOTSTRAP_PATH}" \
      --dry-run \
      --url "https://github.com/enterprises/example-enterprise" \
      enterprise-runner
)"
grep -Fq "GitHub registration target: enterprise" <<< "${enterprise_output}"

if RUNNER_REGISTRY_PATH="${temp_dir}/invalid-url-runners.tsv" \
  RUNNER_MANAGE_RUNNERS_PATH="${manage_stub}" \
  RUNNER_LAUNCHCTL_BIN="${launchctl_stub}" \
  RUNNER_DIRECTORY_PREFIX="${temp_dir}/actions-runner" \
  RUNNER_TEST_OPERATIONS_LOG="${operations_log}" \
  "${BOOTSTRAP_PATH}" \
    --dry-run \
    --url "https://github.com/example-org/repository/extra-segment" \
    mac-runner-invalid-url \
  >/dev/null 2>"${temp_dir}/invalid-url.err"; then
  echo "expected bootstrap with an invalid GitHub URL to fail"
  exit 1
fi
grep -Fq "repository, organization, or enterprise URL" "${temp_dir}/invalid-url.err"
