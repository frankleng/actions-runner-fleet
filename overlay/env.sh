#!/bin/bash

set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -h "${SOURCE}" ]; do
  DIR="$(cd -P "$(dirname "${SOURCE}")" && pwd)"
  SOURCE="$(readlink "${SOURCE}")"
  [[ "${SOURCE}" != /* ]] && SOURCE="${DIR}/${SOURCE}"
done
RUNNER_ROOT="$(cd -P "$(dirname "${SOURCE}")" && pwd)"

KIT_ROOT="${RUNNER_KIT_ROOT:-}"
if [ -z "${KIT_ROOT}" ] && [ -f "${RUNNER_ROOT}/.kit-root" ]; then
  KIT_ROOT="$(cat "${RUNNER_ROOT}/.kit-root")"
fi
# Runners default to <kit>/.runners/<name>, so the kit is two levels up.
KIT_ROOT="${KIT_ROOT:-$(cd "${RUNNER_ROOT}/../.." && pwd)}"

PROVISION_SCRIPT_PATH="${RUNNER_PROVISION_SCRIPT_PATH:-${KIT_ROOT}/provision-runner-tooling.sh}"
if [ ! -x "${PROVISION_SCRIPT_PATH}" ]; then
  echo "provisioning script is missing or not executable: ${PROVISION_SCRIPT_PATH}" >&2
  exit 1
fi

exec "${PROVISION_SCRIPT_PATH}" --root "${RUNNER_ROOT}" --write-env
