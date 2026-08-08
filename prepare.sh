#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/platform.sh"
RUNNER_ARCHIVE_NAME="${RUNNER_ARCHIVE_BASENAME}"
RUNNER_ARCHIVE_PATH="${SCRIPT_DIR}/${RUNNER_ARCHIVE_NAME}"
FLEET_PATH="${SCRIPT_DIR}/fleet.tsv"
FLEET_EXAMPLE_PATH="${SCRIPT_DIR}/fleet.example.tsv"
PREPARE_NODE_VERSION="24.19.0"
PREPARE_PNPM_VERSION="11.20.0"
PREPARE_NODE_DIR="${SCRIPT_DIR}/host-tools/node-${PREPARE_NODE_VERSION}-${RUNNER_NODE_PLATFORM}"
PREPARE_NODE_BIN_DIR="${PREPARE_NODE_DIR}/bin"
PREPARE_COREPACK_HOME="${SCRIPT_DIR}/host-tools/corepack"
PREPARE_PNPM_HOME="${SCRIPT_DIR}/host-tools/pnpm"
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
  case "${os_name}:${architecture}" in
    Darwin:arm64|Linux:x86_64) ;;
    *) fail "unsupported host: ${os_name} ${architecture}" ;;
  esac
}

verify_runner_archive() {
  local actual_checksum

  [ -f "${RUNNER_ARCHIVE_PATH}" ] || return 1
  actual_checksum="$(runner_sha256 "${RUNNER_ARCHIVE_PATH}" | awk '{print $1}')"
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
for required_command in awk curl tar "${RUNNER_SHA256_COMMAND}"; do
  require_command "${required_command}"
done

if [ "${CHECK_ONLY}" -eq 1 ]; then
  verify_runner_archive || fail "runner archive is missing or has the wrong checksum"
  if [ ! -d "${SCRIPT_DIR}/runnerctl-app/node_modules/blessed" ]; then
    echo "note: dashboard dependency is not installed; rerun ./prepare.sh" >&2
  fi
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
  echo "downloading GitHub Actions Runner ${RUNNER_VERSION} for ${RUNNER_PLATFORM}"
  curl -fL "${RUNNER_ARCHIVE_URL}" -o "${download_path}"
  actual_checksum="$(runner_sha256 "${download_path}" | awk '{print $1}')"
  [ "${actual_checksum}" = "${RUNNER_ARCHIVE_SHA256}" ] ||
    fail "downloaded runner archive checksum mismatch"
  mv "${download_path}" "${RUNNER_ARCHIVE_PATH}"
  trap - EXIT
  echo "runner archive ${RUNNER_VERSION}: checksum verified"
fi

if [ ! -x "${PREPARE_NODE_BIN_DIR}/node" ] || [ ! -x "${PREPARE_NODE_BIN_DIR}/corepack" ]; then
  node_archive="node-v${PREPARE_NODE_VERSION}-${RUNNER_NODE_PLATFORM}.tar.gz"
  node_temp_dir="$(mktemp -d "${SCRIPT_DIR}/.prepare-node.XXXXXX")"
  trap 'rm -rf "${node_temp_dir}"' EXIT
  echo "downloading Node.js ${PREPARE_NODE_VERSION} for pnpm-based dashboard preparation"
  curl -fsSL "https://nodejs.org/dist/v${PREPARE_NODE_VERSION}/${node_archive}" -o "${node_temp_dir}/${node_archive}"
  tar -xzf "${node_temp_dir}/${node_archive}" -C "${node_temp_dir}"
  mkdir -p "${SCRIPT_DIR}/host-tools"
  rm -rf "${PREPARE_NODE_DIR}"
  mv "${node_temp_dir}/node-v${PREPARE_NODE_VERSION}-${RUNNER_NODE_PLATFORM}" "${PREPARE_NODE_DIR}"
  rm -rf "${node_temp_dir}"
  trap - EXIT
fi

mkdir -p "${PREPARE_COREPACK_HOME}" "${PREPARE_PNPM_HOME}"
installed_pnpm_version="$(
  COREPACK_HOME="${PREPARE_COREPACK_HOME}" \
  PATH="${PREPARE_PNPM_HOME}:${PREPARE_NODE_BIN_DIR}:${PATH}" \
    "${PREPARE_PNPM_HOME}/pnpm" --version 2>/dev/null || true
)"
if [ "${installed_pnpm_version}" != "${PREPARE_PNPM_VERSION}" ]; then
  COREPACK_HOME="${PREPARE_COREPACK_HOME}" PATH="${PREPARE_NODE_BIN_DIR}:${PATH}" \
    "${PREPARE_NODE_BIN_DIR}/corepack" install --global "pnpm@${PREPARE_PNPM_VERSION}"
  COREPACK_HOME="${PREPARE_COREPACK_HOME}" PATH="${PREPARE_NODE_BIN_DIR}:${PATH}" \
    "${PREPARE_NODE_BIN_DIR}/corepack" enable --install-directory "${PREPARE_PNPM_HOME}" pnpm
fi

(
  cd "${SCRIPT_DIR}/runnerctl-app"
  COREPACK_HOME="${PREPARE_COREPACK_HOME}" \
  PNPM_HOME="${PREPARE_PNPM_HOME}" \
  PATH="${PREPARE_PNPM_HOME}:${PREPARE_NODE_BIN_DIR}:${PATH}" \
    "${PREPARE_PNPM_HOME}/pnpm" install --frozen-lockfile
)

if [ ! -f "${FLEET_PATH}" ]; then
  [ -f "${FLEET_EXAMPLE_PATH}" ] ||
    fail "fleet example is missing: ${FLEET_EXAMPLE_PATH}"
  cp "${FLEET_EXAMPLE_PATH}" "${FLEET_PATH}"
  echo "created ${FLEET_PATH}"
fi

echo
echo "preparation complete"
echo "next: edit ${FLEET_PATH}, then run ./restore-fleet.sh --check"
