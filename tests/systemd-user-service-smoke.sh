#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT
runner_dir="${temp_dir}/runner"
unit_dir="${temp_dir}/units"
systemctl_stub="${temp_dir}/systemctl"
systemctl_log="${temp_dir}/systemctl.log"
loginctl_stub="${temp_dir}/loginctl"
loginctl_log="${temp_dir}/loginctl.log"

mkdir -p "${runner_dir}/bin" "${runner_dir}/_diag"
mkdir -p "${temp_dir}/host-tools/pnpm-tools/bin"
cat > "${temp_dir}/host-tools/pnpm-tools/bin/wrangler" <<'EOF'
#!/bin/sh
printf '4.69.0\n'
EOF
chmod u+x "${temp_dir}/host-tools/pnpm-tools/bin/wrangler"
cp "${ROOT_DIR}/overlay/svc-systemd-user.sh" "${runner_dir}/svc.sh"
cp "${ROOT_DIR}/overlay/env.sh" "${runner_dir}/env.sh"
cp "${ROOT_DIR}/overlay/runsvc.sh" "${runner_dir}/bin/runsvc.sh"
cp "${ROOT_DIR}/overlay/bin/actions.runner.service.template" "${runner_dir}/bin/actions.runner.service.template"
chmod u+x "${runner_dir}/svc.sh" "${runner_dir}/env.sh" "${runner_dir}/bin/runsvc.sh"
printf '%s\n' '{"agentName":"ubuntu-runner-1","gitHubUrl":"https://github.com/example-org","workFolder":"_work"}' > "${runner_dir}/.runner"

cat > "${systemctl_stub}" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "${RUNNER_TEST_SYSTEMCTL_LOG:?}"
case "$*" in
  *"is-active --quiet"*) exit 0 ;;
  *"show -p MainPID --value"*) echo 4242 ;;
esac
EOF
chmod u+x "${systemctl_stub}"

cat > "${loginctl_stub}" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "${RUNNER_TEST_LOGINCTL_LOG:?}"
case "$*" in
  show-user*) echo "no" ;;
esac
EOF
chmod u+x "${loginctl_stub}"

RUNNER_PROVISION_SCRIPT_PATH="${ROOT_DIR}/provision-runner-tooling.sh" \
RUNNER_HOST_TOOLS_DIR="${temp_dir}/host-tools" \
RUNNER_PNPM_STORE_DIR="${temp_dir}/pnpm-store" \
RUNNER_LOGINCTL_BIN="${loginctl_stub}" RUNNER_TEST_LOGINCTL_LOG="${loginctl_log}" \
RUNNER_SYSTEMCTL_BIN="${systemctl_stub}" RUNNER_SYSTEMD_USER_DIR="${unit_dir}" RUNNER_TEST_SYSTEMCTL_LOG="${systemctl_log}" "${runner_dir}/svc.sh" install
status_output="$(RUNNER_SYSTEMCTL_BIN="${systemctl_stub}" RUNNER_SYSTEMD_USER_DIR="${unit_dir}" RUNNER_TEST_SYSTEMCTL_LOG="${systemctl_log}" "${runner_dir}/svc.sh" status)"

unit_path="${unit_dir}/actions.runner.example-org.ubuntu-runner-1.service"
[ -f "${unit_path}" ]
grep -Fq "WorkingDirectory=${runner_dir}" "${unit_path}"
grep -Fq "ExecStart=${runner_dir}/runsvc.sh" "${unit_path}"
grep -Fq "CPUQuota=200%" "${unit_path}"
grep -Fxq "200" "${runner_dir}/.cpu-quota"
grep -Fq "Started:" <<< "${status_output}"
grep -Fq "CPU limit: 200%" <<< "${status_output}"
grep -Fq "4242 0 actions.runner.example-org.ubuntu-runner-1" <<< "${status_output}"
grep -Fq -- "--user daemon-reload" "${systemctl_log}"
grep -Fq -- "--user enable actions.runner.example-org.ubuntu-runner-1.service" "${systemctl_log}"
grep -Fq -- "enable-linger $(id -un)" "${loginctl_log}"
grep -Fq -- "--user set-property --runtime actions.runner.example-org.ubuntu-runner-1.service CPUQuota=200%" "${systemctl_log}"

RUNNER_SYSTEMCTL_BIN="${systemctl_stub}" RUNNER_SYSTEMD_USER_DIR="${unit_dir}" RUNNER_TEST_SYSTEMCTL_LOG="${systemctl_log}" "${runner_dir}/svc.sh" set-cpu-limit 175

grep -Fq "CPUQuota=175%" "${unit_path}"
grep -Fxq "175" "${runner_dir}/.cpu-quota"
grep -Fq -- "--user set-property --runtime actions.runner.example-org.ubuntu-runner-1.service CPUQuota=175%" "${systemctl_log}"
