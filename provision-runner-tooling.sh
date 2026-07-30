#!/bin/bash

set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"

ROOT_DIR="${SCRIPT_DIR}"
DRY_RUN=0
PRINT_ENV=0
PRINT_MANIFEST=0

NODE_VERSION="22.21.1"
PNPM_VERSION="9.4.0"
WRANGLER_VERSION="4.69.0"
PULUMI_VERSION="3.143.0"
AWS_VERSION="2.36.11"

usage() {
  cat <<EOF
Usage:
  ./provision-runner-tooling.sh [--root PATH] [--dry-run] [--print-env] [--print-manifest]

Installs a pinned runner-local toolchain under the runner root.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      ROOT_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --print-env)
      PRINT_ENV=1
      shift
      ;;
    --print-manifest)
      PRINT_MANIFEST=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

TOOLS_DIR="${ROOT_DIR}/tools"
HOST_TOOLS_DIR="${RUNNER_HOST_TOOLS_DIR:-${SCRIPT_DIR}/host-tools}"
LOCAL_BIN_DIR="${TOOLS_DIR}/bin"
NPM_GLOBAL_DIR="${TOOLS_DIR}/npm-global"
NPM_GLOBAL_BIN="${NPM_GLOBAL_DIR}/bin"
PNPM_GLOBAL_DIR="${TOOLS_DIR}/pnpm-global"
PNPM_HOME="${PNPM_GLOBAL_DIR}/bin"
COREPACK_HOME="${TOOLS_DIR}/corepack"
PULUMI_HOME="${TOOLS_DIR}/pulumi-home"
RUNNER_HOME="${ROOT_DIR}/home"
RUNNER_TMP="${ROOT_DIR}/tmp"
RUNNER_TEMP="${ROOT_DIR}/_work/_temp"
RUNNER_TOOL_CACHE="${ROOT_DIR}/_work/_tool"
NODE_ARCH="arm64"
NODE_INSTALL_DIR="${RUNNER_TOOL_CACHE}/node/${NODE_VERSION}/${NODE_ARCH}"
NODE_BIN_DIR="${NODE_INSTALL_DIR}/bin"
NODE_COMPLETE_MARKER="${RUNNER_TOOL_CACHE}/node/${NODE_VERSION}/${NODE_ARCH}.complete"
PULUMI_INSTALL_DIR="${TOOLS_DIR}/pulumi/${PULUMI_VERSION}"
AWS_INSTALL_DIR="${HOST_TOOLS_DIR}/aws-cli/${AWS_VERSION}"
AWS_BIN_PATH="${AWS_INSTALL_DIR}/aws"
AWS_PKG_URL="${RUNNER_AWS_PKG_URL:-https://awscli.amazonaws.com/AWSCLIV2-${AWS_VERSION}.pkg}"
MANIFEST_PATH="${TOOLS_DIR}/runner-tooling.env"
AMBIENT_HOME="${HOME:-}"

is_filtered_path_entry() {
  local entry="$1"

  if [ -z "${entry}" ]; then
    return 0
  fi

  if [ -n "${AMBIENT_HOME}" ] && {
    [ "${entry}" = "${AMBIENT_HOME}/Library/pnpm" ] ||
    [ "${entry}" = "${AMBIENT_HOME}/setup-pnpm" ]
  }; then
    return 0
  fi

  return 1
}

append_unique_path_entry() {
  local current="$1"
  local entry="$2"

  if [ -z "${entry}" ]; then
    printf '%s\n' "${current}"
    return 0
  fi

  case ":${current}:" in
    *":${entry}:"*)
      printf '%s\n' "${current}"
      ;;
    *)
      if [ -n "${current}" ]; then
        printf '%s:%s\n' "${current}" "${entry}"
      else
        printf '%s\n' "${entry}"
      fi
      ;;
  esac
}

sanitize_path() {
  local current_path="$1"
  local sanitized=""
  local entry
  local IFS=':'

  read -r -a entries <<< "${current_path}"
  for entry in "${entries[@]}"; do
    if is_filtered_path_entry "${entry}"; then
      continue
    fi
    sanitized="$(append_unique_path_entry "${sanitized}" "${entry}")"
  done

  printf '%s\n' "${sanitized}"
}

build_runner_path() {
  local current_path="${1:-/usr/bin:/bin:/usr/sbin:/sbin}"
  local runner_path=""
  local ambient_path
  local entry

  ambient_path="$(sanitize_path "${current_path}")"
  for entry in "${LOCAL_BIN_DIR}" "${PNPM_HOME}" "${NPM_GLOBAL_BIN}" "${NODE_BIN_DIR}"; do
    runner_path="$(append_unique_path_entry "${runner_path}" "${entry}")"
  done

  local IFS=':'
  read -r -a ambient_entries <<< "${ambient_path}"
  for entry in "${ambient_entries[@]}"; do
    runner_path="$(append_unique_path_entry "${runner_path}" "${entry}")"
  done

  printf '%s\n' "${runner_path}"
}

manifest_contents() {
  cat <<EOF
RUNNER_TOOL_NODE_VERSION=${NODE_VERSION}
RUNNER_TOOL_PNPM_VERSION=${PNPM_VERSION}
RUNNER_TOOL_WRANGLER_VERSION=${WRANGLER_VERSION}
RUNNER_TOOL_PULUMI_VERSION=${PULUMI_VERSION}
RUNNER_TOOL_AWS_VERSION=${AWS_VERSION}
EOF
}

print_env() {
  local current_path="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  local runner_path

  runner_path="$(build_runner_path "${current_path}")"
  printf 'HOME=%q\n' "${RUNNER_HOME}"
  printf 'TMPDIR=%q\n' "${RUNNER_TMP}"
  printf 'RUNNER_TEMP=%q\n' "${RUNNER_TEMP}"
  printf 'RUNNER_TOOL_CACHE=%q\n' "${RUNNER_TOOL_CACHE}"
  printf 'PNPM_HOME=%q\n' "${PNPM_HOME}"
  printf 'COREPACK_HOME=%q\n' "${COREPACK_HOME}"
  printf 'PULUMI_HOME=%q\n' "${PULUMI_HOME}"
  printf 'PATH=%q\n' "${runner_path}"
}

ensure_directory() {
  if [ "${DRY_RUN}" -eq 1 ]; then
    return 0
  fi

  mkdir -p "$1"
}

ensure_symlink() {
  local target="$1"
  local link_path="$2"

  if [ "${DRY_RUN}" -eq 1 ]; then
    return 0
  fi

  mkdir -p "$(dirname "${link_path}")"
  ln -sfn "${target}" "${link_path}"
}

download_node() {
  local temp_dir archive_name extract_dir
  temp_dir="$(mktemp -d)"
  archive_name="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
  extract_dir="${temp_dir}/node-extract"

  mkdir -p "${extract_dir}"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${archive_name}" -o "${temp_dir}/${archive_name}"
  tar -xzf "${temp_dir}/${archive_name}" -C "${extract_dir}"
  mkdir -p "$(dirname "${NODE_INSTALL_DIR}")"
  rm -rf "${NODE_INSTALL_DIR}"
  mv "${extract_dir}/node-v${NODE_VERSION}-darwin-arm64" "${NODE_INSTALL_DIR}"
  touch "${NODE_COMPLETE_MARKER}"
  rm -rf "${temp_dir}"
}

install_node() {
  if [ -x "${NODE_BIN_DIR}/node" ] && [ -f "${NODE_COMPLETE_MARKER}" ]; then
    return 0
  fi

  if [ "${DRY_RUN}" -eq 1 ]; then
    return 0
  fi

  download_node
}

install_pnpm() {
  if [ -x "${PNPM_HOME}/pnpm" ]; then
    return 0
  fi

  if [ "${DRY_RUN}" -eq 1 ]; then
    return 0
  fi

  mkdir -p "${PNPM_GLOBAL_DIR}" "${COREPACK_HOME}"
  PATH="${NODE_BIN_DIR}:${PATH}" "${NODE_BIN_DIR}/npm" install --global --prefix "${PNPM_GLOBAL_DIR}" "pnpm@${PNPM_VERSION}"
}

install_wrangler() {
  if [ -x "${NPM_GLOBAL_BIN}/wrangler" ]; then
    ensure_symlink "${NPM_GLOBAL_BIN}/wrangler" "${LOCAL_BIN_DIR}/wrangler"
    return 0
  fi

  if [ "${DRY_RUN}" -eq 1 ]; then
    return 0
  fi

  mkdir -p "${NPM_GLOBAL_DIR}"
  PATH="${NODE_BIN_DIR}:${PNPM_HOME}:${PATH}" "${NODE_BIN_DIR}/npm" install --global --prefix "${NPM_GLOBAL_DIR}" "wrangler@${WRANGLER_VERSION}"
  ensure_symlink "${NPM_GLOBAL_BIN}/wrangler" "${LOCAL_BIN_DIR}/wrangler"
}

install_pulumi() {
  local system_pulumi
  system_pulumi="/opt/homebrew/Cellar/pulumi/${PULUMI_VERSION}/bin/pulumi"

  if [ -x "${PULUMI_INSTALL_DIR}/bin/pulumi" ]; then
    ensure_symlink "${PULUMI_INSTALL_DIR}/bin/pulumi" "${LOCAL_BIN_DIR}/pulumi"
    return 0
  fi

  if [ "${DRY_RUN}" -eq 1 ]; then
    return 0
  fi

  mkdir -p "${PULUMI_INSTALL_DIR}/bin" "${PULUMI_HOME}"

  if [ -x "${system_pulumi}" ]; then
    cp "${system_pulumi}" "${PULUMI_INSTALL_DIR}/bin/pulumi"
    chmod +x "${PULUMI_INSTALL_DIR}/bin/pulumi"
  else
    local temp_dir archive_name
    temp_dir="$(mktemp -d)"
    archive_name="pulumi-v${PULUMI_VERSION}-darwin-arm64.tar.gz"
    curl -fsSL "https://get.pulumi.com/releases/sdk/${archive_name}" -o "${temp_dir}/${archive_name}"
    tar -xzf "${temp_dir}/${archive_name}" -C "${temp_dir}"
    cp "${temp_dir}/pulumi/pulumi" "${PULUMI_INSTALL_DIR}/bin/pulumi"
    chmod +x "${PULUMI_INSTALL_DIR}/bin/pulumi"
    rm -rf "${temp_dir}"
  fi

  ensure_symlink "${PULUMI_INSTALL_DIR}/bin/pulumi" "${LOCAL_BIN_DIR}/pulumi"
}

install_aws() {
  local version_output

  if [ -x "${AWS_BIN_PATH}" ]; then
    version_output="$("${AWS_BIN_PATH}" --version 2>&1 || true)"
  else
    version_output=""
  fi

  if [[ "${version_output}" == aws-cli/${AWS_VERSION}\ * ]]; then
    ensure_symlink "${AWS_BIN_PATH}" "${LOCAL_BIN_DIR}/aws"
    return 0
  fi

  if [ "${DRY_RUN}" -eq 1 ]; then
    return 0
  fi

  mkdir -p "${HOST_TOOLS_DIR}/aws-cli"

  (
    set -euo pipefail

    local temp_dir
    local package_path
    local expanded_path
    local payload_path
    local signature_output
    local backup_path

    temp_dir="$(mktemp -d "${HOST_TOOLS_DIR}/aws-cli/.install-${AWS_VERSION}.XXXXXX")"
    trap 'rm -rf "${temp_dir}"' EXIT
    package_path="${temp_dir}/AWSCLIV2.pkg"
    expanded_path="${temp_dir}/expanded"

    curl -fsSL "${AWS_PKG_URL}" -o "${package_path}"
    signature_output="$(pkgutil --check-signature "${package_path}")"
    if ! printf '%s\n' "${signature_output}" | grep -Fq "Developer ID Installer: AMZN Mobile LLC (94KV3E626L)"; then
      echo "AWS CLI package is not signed by the expected Amazon installer identity" >&2
      exit 1
    fi

    pkgutil --expand-full "${package_path}" "${expanded_path}"
    payload_path="${expanded_path}/aws-cli.pkg/Payload/aws-cli"
    if [ ! -x "${payload_path}/aws" ]; then
      echo "AWS CLI package payload is missing its executable" >&2
      exit 1
    fi

    if [ -e "${AWS_INSTALL_DIR}" ]; then
      backup_path="${AWS_INSTALL_DIR}.invalid-$(date -u +%Y%m%d-%H%M%S)"
      mv "${AWS_INSTALL_DIR}" "${backup_path}"
    fi
    mv "${payload_path}" "${AWS_INSTALL_DIR}"
  )

  version_output="$("${AWS_BIN_PATH}" --version 2>&1 || true)"
  if [[ "${version_output}" != aws-cli/${AWS_VERSION}\ * ]]; then
    echo "AWS CLI ${AWS_VERSION} verification failed: ${version_output}" >&2
    exit 1
  fi

  ensure_symlink "${AWS_BIN_PATH}" "${LOCAL_BIN_DIR}/aws"
}

write_manifest() {
  if [ "${DRY_RUN}" -eq 1 ]; then
    return 0
  fi

  mkdir -p "${TOOLS_DIR}"
  manifest_contents > "${MANIFEST_PATH}"
}

if [ "${PRINT_MANIFEST}" -eq 1 ]; then
  manifest_contents
  exit 0
fi

if [ "${PRINT_ENV}" -eq 1 ]; then
  print_env
  exit 0
fi

ensure_directory "${RUNNER_HOME}/Library/Logs"
ensure_directory "${RUNNER_TMP}"
ensure_directory "${RUNNER_TEMP}"
ensure_directory "${RUNNER_TOOL_CACHE}"
ensure_directory "${LOCAL_BIN_DIR}"
ensure_directory "${NPM_GLOBAL_BIN}"
ensure_directory "${PNPM_HOME}"
ensure_directory "${COREPACK_HOME}"
ensure_directory "${PULUMI_HOME}"
install_node
install_pnpm
install_wrangler
install_pulumi
install_aws
write_manifest
