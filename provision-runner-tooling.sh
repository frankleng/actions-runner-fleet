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
source "${SCRIPT_DIR}/platform.sh"
DRY_RUN=0
PRINT_ENV=0
PRINT_MANIFEST=0
WRITE_ENV=0

NODE_VERSION="24.19.0"
PNPM_VERSION="11.20.0"
WRANGLER_VERSION="4.69.0"
PULUMI_VERSION="3.143.0"
AWS_VERSION="2.36.11"

usage() {
  cat <<EOF
Usage:
  ./provision-runner-tooling.sh [--root PATH] [--dry-run] [--print-env] [--print-manifest] [--write-env]

Installs a pinned toolchain for the runner root. Version-pinned tools and the
pnpm store are shared by every runner on the host; only symlinks, pnpm shims,
and runtime state live under the runner root. --write-env refreshes the
runner's .env, .path, and home .npmrc without reinstalling anything.
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
    --write-env)
      WRITE_ENV=1
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

# Per-runner state stays under the runner root; everything version-pinned and
# content-addressed is shared by all runners on this host.
TOOLS_DIR="${ROOT_DIR}/tools"
HOST_TOOLS_DIR="${RUNNER_HOST_TOOLS_DIR:-${SCRIPT_DIR}/host-tools}"
LOCAL_BIN_DIR="${TOOLS_DIR}/bin"
PNPM_GLOBAL_DIR="${TOOLS_DIR}/pnpm-global"
PNPM_HOME="${PNPM_GLOBAL_DIR}/bin"
COREPACK_HOME="${HOST_TOOLS_DIR}/corepack"
PNPM_TOOLS_DIR="${HOST_TOOLS_DIR}/pnpm-tools"
PNPM_TOOLS_BIN_DIR="${PNPM_TOOLS_DIR}/bin"
PNPM_STORE_DIR="${RUNNER_PNPM_STORE_DIR:-${SCRIPT_DIR}/.pnpm-store}"
NPM_CACHE_DIR="${HOST_TOOLS_DIR}/npm-cache"
PULUMI_HOME="${HOST_TOOLS_DIR}/pulumi-home"
RUNNER_HOME="${ROOT_DIR}/home"
RUNNER_TMP="${ROOT_DIR}/tmp"
RUNNER_TEMP="${ROOT_DIR}/_work/_temp"
RUNNER_TOOL_CACHE="${RUNNER_SHARED_TOOL_CACHE:-${HOST_TOOLS_DIR}/tool-cache}"
NODE_ARCH="${RUNNER_NODE_ARCH}"
NODE_INSTALL_DIR="${RUNNER_TOOL_CACHE}/node/${NODE_VERSION}/${NODE_ARCH}"
NODE_BIN_DIR="${NODE_INSTALL_DIR}/bin"
NODE_COMPLETE_MARKER="${RUNNER_TOOL_CACHE}/node/${NODE_VERSION}/${NODE_ARCH}.complete"
PULUMI_INSTALL_DIR="${HOST_TOOLS_DIR}/pulumi/${PULUMI_VERSION}"
AWS_INSTALL_DIR="${HOST_TOOLS_DIR}/aws-cli/${AWS_VERSION}"
if [ "${RUNNER_SERVICE_MANAGER}" = "launchd" ]; then
  AWS_BIN_PATH="${AWS_INSTALL_DIR}/aws"
  AWS_PACKAGE_URL="${RUNNER_AWS_PACKAGE_URL:-https://awscli.amazonaws.com/AWSCLIV2-${AWS_VERSION}.pkg}"
else
  AWS_BIN_PATH="${AWS_INSTALL_DIR}/v2/current/bin/aws"
  AWS_PACKAGE_URL="${RUNNER_AWS_PACKAGE_URL:-https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWS_VERSION}.zip}"
fi
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
  for entry in "${LOCAL_BIN_DIR}" "${PNPM_HOME}" "${NODE_BIN_DIR}"; do
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

env_file_lines() {
  printf 'LANG=%q\n' "${LANG:-en_US.UTF-8}"
  printf 'HOME=%q\n' "${RUNNER_HOME}"
  printf 'TMPDIR=%q\n' "${RUNNER_TMP}"
  printf 'RUNNER_TEMP=%q\n' "${RUNNER_TEMP}"
  printf 'RUNNER_TOOL_CACHE=%q\n' "${RUNNER_TOOL_CACHE}"
  printf 'PNPM_HOME=%q\n' "${PNPM_HOME}"
  printf 'COREPACK_HOME=%q\n' "${COREPACK_HOME}"
  printf 'PULUMI_HOME=%q\n' "${PULUMI_HOME}"
}

print_env() {
  local current_path="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

  env_file_lines
  printf 'PATH=%q\n' "$(build_runner_path "${current_path}")"
}

# Point package managers in runner jobs at the shared content-addressable
# stores; without this, every runner home accumulates a private copy. Both
# stores are safe for concurrent use by multiple runners on one filesystem.
write_npmrc() {
  local npmrc_path="${RUNNER_HOME}/.npmrc"
  local temp_npmrc_path="${npmrc_path}.tmp"

  {
    if [ -f "${npmrc_path}" ]; then
      grep -v -e '^store-dir=' -e '^cache=' "${npmrc_path}" || true
    fi
    printf 'store-dir=%s\n' "${PNPM_STORE_DIR}"
    printf 'cache=%s\n' "${NPM_CACHE_DIR}"
  } > "${temp_npmrc_path}"
  mv "${temp_npmrc_path}" "${npmrc_path}"
}

write_env_files() {
  local env_path="${ROOT_DIR}/.env"
  local path_path="${ROOT_DIR}/.path"
  local current_path="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

  mkdir -p \
    "${RUNNER_HOME}/Library/Logs" \
    "${RUNNER_TMP}" \
    "${RUNNER_TEMP}" \
    "${LOCAL_BIN_DIR}" \
    "${PNPM_HOME}"

  ensure_exec_wrapper "${PNPM_TOOLS_BIN_DIR}/wrangler" "${LOCAL_BIN_DIR}/wrangler"
  env_file_lines > "${env_path}.tmp"
  build_runner_path "${current_path}" > "${path_path}.tmp"
  mv "${env_path}.tmp" "${env_path}"
  mv "${path_path}.tmp" "${path_path}"
  write_npmrc
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

# pnpm command launchers resolve their backing module relative to $0. Symlinking
# one into a runner-local bin directory therefore makes it search for the
# shared virtual store under the runner root. Use a wrapper so the shared
# launcher sees its real path and retains the module resolution pnpm generated.
ensure_exec_wrapper() {
  local target="$1"
  local wrapper_path="$2"
  local temp_wrapper_path="${wrapper_path}.tmp"

  if [ "${DRY_RUN}" -eq 1 ]; then
    return 0
  fi
  if [ ! -x "${target}" ]; then
    echo "runner tool launcher is missing or not executable: ${target}" >&2
    exit 1
  fi

  mkdir -p "$(dirname "${wrapper_path}")"
  printf '#!/bin/bash\nexec %q "$@"\n' "${target}" > "${temp_wrapper_path}"
  chmod u+x "${temp_wrapper_path}"
  mv "${temp_wrapper_path}" "${wrapper_path}"
}

download_node() {
  local temp_dir archive_name extract_dir
  temp_dir="$(mktemp -d)"
  archive_name="node-v${NODE_VERSION}-${RUNNER_NODE_PLATFORM}.tar.gz"
  extract_dir="${temp_dir}/node-extract"

  mkdir -p "${extract_dir}"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${archive_name}" -o "${temp_dir}/${archive_name}"
  tar -xzf "${temp_dir}/${archive_name}" -C "${extract_dir}"
  mkdir -p "$(dirname "${NODE_INSTALL_DIR}")"
  rm -rf "${NODE_INSTALL_DIR}"
  mv "${extract_dir}/node-v${NODE_VERSION}-${RUNNER_NODE_PLATFORM}" "${NODE_INSTALL_DIR}"
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
  local installed_version=""

  if [ -x "${PNPM_HOME}/pnpm" ]; then
    installed_version="$(
      COREPACK_HOME="${COREPACK_HOME}" \
      PATH="${LOCAL_BIN_DIR}:${PNPM_HOME}:${NODE_BIN_DIR}:${PATH}" \
        "${PNPM_HOME}/pnpm" --version 2>/dev/null || true
    )"
  fi
  if [ "${installed_version}" = "${PNPM_VERSION}" ]; then
    return 0
  fi

  if [ "${DRY_RUN}" -eq 1 ]; then
    return 0
  fi

  mkdir -p "${PNPM_HOME}" "${COREPACK_HOME}"
  COREPACK_HOME="${COREPACK_HOME}" PATH="${NODE_BIN_DIR}:${PATH}" \
    "${NODE_BIN_DIR}/corepack" install --global "pnpm@${PNPM_VERSION}"
  COREPACK_HOME="${COREPACK_HOME}" PATH="${NODE_BIN_DIR}:${PATH}" \
    "${NODE_BIN_DIR}/corepack" enable --install-directory "${PNPM_HOME}" pnpm

  installed_version="$(
    COREPACK_HOME="${COREPACK_HOME}" \
    PATH="${LOCAL_BIN_DIR}:${PNPM_HOME}:${NODE_BIN_DIR}:${PATH}" \
      "${PNPM_HOME}/pnpm" --version
  )"
  [ "${installed_version}" = "${PNPM_VERSION}" ] || {
    echo "pnpm ${PNPM_VERSION} verification failed: ${installed_version}" >&2
    exit 1
  }
}

install_wrangler() {
  local version_output=""

  if [ -x "${PNPM_TOOLS_BIN_DIR}/wrangler" ]; then
    version_output="$(PATH="${PNPM_TOOLS_BIN_DIR}:${PNPM_HOME}:${NODE_BIN_DIR}:${PATH}" "${PNPM_TOOLS_BIN_DIR}/wrangler" --version 2>/dev/null || true)"
  fi

  if [ "${version_output}" != "${WRANGLER_VERSION}" ]; then
    if [ "${DRY_RUN}" -eq 1 ]; then
      return 0
    fi

    mkdir -p "${PNPM_TOOLS_BIN_DIR}" "${PNPM_STORE_DIR}"
    COREPACK_HOME="${COREPACK_HOME}" PNPM_HOME="${PNPM_HOME}" \
    PATH="${PNPM_TOOLS_BIN_DIR}:${PNPM_HOME}:${NODE_BIN_DIR}:${PATH}" \
      "${PNPM_HOME}/pnpm" add --global \
        --global-dir "${PNPM_TOOLS_DIR}" \
        --global-bin-dir "${PNPM_TOOLS_BIN_DIR}" \
        --store-dir "${PNPM_STORE_DIR}" \
        "wrangler@${WRANGLER_VERSION}"

    version_output="$(PATH="${PNPM_TOOLS_BIN_DIR}:${PNPM_HOME}:${NODE_BIN_DIR}:${PATH}" "${PNPM_TOOLS_BIN_DIR}/wrangler" --version)"
    [ "${version_output}" = "${WRANGLER_VERSION}" ] || {
      echo "Wrangler ${WRANGLER_VERSION} verification failed: ${version_output}" >&2
      exit 1
    }
  fi

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
    archive_name="pulumi-v${PULUMI_VERSION}-${RUNNER_PULUMI_PLATFORM}.tar.gz"
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

  if [ "${RUNNER_SERVICE_MANAGER}" = "systemd-user" ]; then
    command -v unzip >/dev/null 2>&1 || { echo "unzip is required to install AWS CLI on Linux" >&2; exit 1; }
    local linux_temp_dir
    linux_temp_dir="$(mktemp -d)"
    trap 'rm -rf "${linux_temp_dir}"' RETURN
    curl -fsSL "${AWS_PACKAGE_URL}" -o "${linux_temp_dir}/awscliv2.zip"
    unzip -q "${linux_temp_dir}/awscliv2.zip" -d "${linux_temp_dir}"
    rm -rf "${AWS_INSTALL_DIR}"
    "${linux_temp_dir}/aws/install" --install-dir "${AWS_INSTALL_DIR}" --bin-dir "${linux_temp_dir}/bin"
    rm -rf "${linux_temp_dir}"
    trap - RETURN
    ensure_symlink "${AWS_BIN_PATH}" "${LOCAL_BIN_DIR}/aws"
    return 0
  fi

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

    curl -fsSL "${AWS_PACKAGE_URL}" -o "${package_path}"
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

if [ "${WRITE_ENV}" -eq 1 ]; then
  write_env_files
  exit 0
fi

ensure_directory "${RUNNER_HOME}/Library/Logs"
ensure_directory "${RUNNER_TMP}"
ensure_directory "${RUNNER_TEMP}"
ensure_directory "${RUNNER_TOOL_CACHE}"
ensure_directory "${LOCAL_BIN_DIR}"
ensure_directory "${PNPM_HOME}"
ensure_directory "${COREPACK_HOME}"
ensure_directory "${PNPM_TOOLS_BIN_DIR}"
ensure_directory "${PNPM_STORE_DIR}"
ensure_directory "${PULUMI_HOME}"
install_node
install_pnpm
install_wrangler
install_pulumi
install_aws
write_manifest
if [ "${DRY_RUN}" -eq 0 ]; then
  write_env_files
fi
