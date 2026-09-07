#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT
mkdir -p "${temp_dir}/kit" "${temp_dir}/image/bin" "${temp_dir}/bin"
cp "${ROOT_DIR}/manage-runners.sh" "${ROOT_DIR}/platform.sh" "${ROOT_DIR}/runner-target.sh" "${temp_dir}/kit/"
cp -R "${ROOT_DIR}/overlay" "${temp_dir}/kit/overlay"
cat > "${temp_dir}/provision" <<'STUB'
#!/bin/bash
set -euo pipefail
# Provisioning is local: no registration credential can reach this command.
[ -z "${RUNNER_AUTOSCALE_TOKEN:-}" ]
STUB
cat > "${temp_dir}/bin/systemctl" <<'STUB'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "${AUTOSCALE_SERVICE_LOG}"
if [ "${2:-}" = is-active ]; then exit 1; fi
STUB
chmod +x "${temp_dir}/provision" "${temp_dir}/bin/systemctl"
export RUNNER_SERVICE_MANAGER_OVERRIDE=systemd-user
export RUNNER_SYSTEMCTL_BIN="${temp_dir}/bin/systemctl"
export RUNNER_SYSTEMD_USER_DIR="${temp_dir}/units"
export RUNNER_LOGINCTL_BIN="${temp_dir}/missing-loginctl"
export RUNNER_IMAGE_DIR="${temp_dir}/image"
export RUNNER_PROVISION_SCRIPT_PATH="${temp_dir}/provision"
export AUTOSCALE_SERVICE_LOG="${temp_dir}/services.log"
"${temp_dir}/kit/manage-runners.sh" prepare-autoscale test-slot https://github.com/example-org > "${temp_dir}/setup.log"
slot="${temp_dir}/kit/.runners/test-slot"
[ -f "${slot}/.autoscale-slot.json" ]
[ ! -e "${slot}/.runner" ]
[ ! -e "${slot}/.credentials" ]
[ -f "${slot}/bin/autoscale-worker.mjs" ]
[ -f "${slot}/.service" ]
[ -f "${slot}/.cpu-quota" ]
# Setup installs only the parked service; no start/stop, token, or remote registration.
if grep -E -- '--user (start|stop)' "${AUTOSCALE_SERVICE_LOG}"; then exit 1; fi
if "${temp_dir}/kit/manage-runners.sh" prepare-autoscale test-slot https://github.com/example-org > /dev/null 2>&1; then
  echo "must refuse existing slots" >&2; exit 1
fi
# Both service implementations can still read identity after .runner is removed.
(cd "${slot}" && ./svc.sh status) > "${temp_dir}/status"
grep -q 'Stopped' "${temp_dir}/status"
echo 'autoscale slot provisioning passed'
