#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_VERSION="2.336.0"
RUNNER_ARCHIVE_NAME="actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"
RUNNER_ARCHIVE_PATH="${SCRIPT_DIR}/${RUNNER_ARCHIVE_NAME}"
RUNNER_ARCHIVE_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_ARCHIVE_NAME}"
RUNNER_ARCHIVE_SHA256="8e8839c49b7060b6b2154f4931f815df330c27f167d53ef2239ee3dfce28b079"
FLEET_PATH="${SCRIPT_DIR}/fleet.tsv"
FLEET_EXAMPLE_PATH="${SCRIPT_DIR}/fleet.example.tsv"
CHECK_ONLY=0

usage() {
  cat <<'EOF'
Usage:
  ./prepare.sh
  ./prepare.sh --check

Downloads and verifies the pinned GitHub Actions runner, installs the dashboard
dependency, and creates an ignored fleet.tsv from fleet.example.tsv.
EOF
}

fail() {
  echo "prepare failed: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    fail "required command is unavailable: $1"
}

verify_host() {
  local architecture
  local os_name

  os_name="$(uname -s)"
  architecture="$(uname -m)"
  [ "${os_name}" = "Darwin" ] ||
    fail "this kit supports macOS only (detected ${os_name})"
  [ "${architecture}" = "arm64" ] ||
    fail "this kit requires a native Apple-silicon shell (detected ${architecture})"
}

verify_runner_archive() {
  local actual_checksum

  [ -f "${RUNNER_ARCHIVE_PATH}" ] || return 1
  actual_checksum="$(shasum -a 256 "${RUNNER_ARCHIVE_PATH}" | awk '{print $1}')"
  [ "${actual_checksum}" = "${RUNNER_ARCHIVE_SHA256}" ]
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      CHECK_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

verify_host
for required_command in awk curl npm shasum; do
  require_command "${required_command}"
done

if [ "${CHECK_ONLY}" -eq 1 ]; then
  verify_runner_archive || fail "runner archive is missing or has the wrong checksum"
  [ -d "${SCRIPT_DIR}/runnerctl-app/node_modules/blessed" ] ||
    fail "dashboard dependency is not installed; run ./prepare.sh"
  [ -f "${FLEET_PATH}" ] ||
    fail "fleet.tsv is missing; run ./prepare.sh and customize it"
  echo "source checkout is prepared"
  exit 0
fi

if verify_runner_archive; then
  echo "runner archive ${RUNNER_VERSION}: checksum verified"
else
  if [ -f "${RUNNER_ARCHIVE_PATH}" ]; then
    fail "existing runner archive has the wrong checksum: ${RUNNER_ARCHIVE_PATH}"
  fi

  download_path="$(mktemp "${SCRIPT_DIR}/.runner-download.XXXXXX")"
  trap 'rm -f "${download_path}"' EXIT
  echo "downloading GitHub Actions Runner ${RUNNER_VERSION} for macOS arm64"
  curl -fL "${RUNNER_ARCHIVE_URL}" -o "${download_path}"
  actual_checksum="$(shasum -a 256 "${download_path}" | awk '{print $1}')"
  [ "${actual_checksum}" = "${RUNNER_ARCHIVE_SHA256}" ] ||
    fail "downloaded runner archive checksum mismatch"
  mv "${download_path}" "${RUNNER_ARCHIVE_PATH}"
  trap - EXIT
  echo "runner archive ${RUNNER_VERSION}: checksum verified"
fi

npm ci --prefix "${SCRIPT_DIR}/runnerctl-app"

if [ ! -f "${FLEET_PATH}" ]; then
  [ -f "${FLEET_EXAMPLE_PATH}" ] ||
    fail "fleet example is missing: ${FLEET_EXAMPLE_PATH}"
  cp "${FLEET_EXAMPLE_PATH}" "${FLEET_PATH}"
  echo "created ${FLEET_PATH}"
fi

echo
echo "preparation complete"
echo "next: edit ${FLEET_PATH}, then run ./restore-fleet.sh --check"
