#!/bin/bash

set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -h "${SOURCE}" ]; do
  DIR="$(cd -P "$(dirname "${SOURCE}")" && pwd)"
  SOURCE="$(readlink "${SOURCE}")"
  [[ "${SOURCE}" != /* ]] && SOURCE="${DIR}/${SOURCE}"
done
RUNNER_ROOT="$(cd -P "$(dirname "${SOURCE}")" && pwd)"

RUNNER_HOME="${RUNNER_ROOT}/home"
RUNNER_TMP="${RUNNER_ROOT}/tmp"
RUNNER_TEMP="${RUNNER_ROOT}/_work/_temp"
RUNNER_TOOL_CACHE="${RUNNER_ROOT}/_work/_tool"
TOOLS_DIR="${RUNNER_ROOT}/tools"
LOCAL_BIN_DIR="${TOOLS_DIR}/bin"
NPM_GLOBAL_BIN="${TOOLS_DIR}/npm-global/bin"
PNPM_HOME="${TOOLS_DIR}/pnpm-global/bin"
COREPACK_HOME="${TOOLS_DIR}/corepack"
PULUMI_HOME="${TOOLS_DIR}/pulumi-home"
NODE_BIN_DIR="${RUNNER_TOOL_CACHE}/node/22.21.1/arm64/bin"
AMBIENT_PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
AMBIENT_HOME="${HOME:-}"
RUNNER_PATH=""

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

build_runner_path() {
  local current_path="$1"
  local path_value=""
  local entry
  local IFS=':'

  for entry in "${LOCAL_BIN_DIR}" "${PNPM_HOME}" "${NPM_GLOBAL_BIN}" "${NODE_BIN_DIR}"; do
    path_value="$(append_unique_path_entry "${path_value}" "${entry}")"
  done

  read -r -a entries <<< "${current_path}"
  for entry in "${entries[@]}"; do
    if is_filtered_path_entry "${entry}"; then
      continue
    fi
    path_value="$(append_unique_path_entry "${path_value}" "${entry}")"
  done

  printf '%s\n' "${path_value}"
}

write_env_file() {
  local env_path="${RUNNER_ROOT}/.env"
  local temp_env_path="${env_path}.tmp"
  local path_path="${RUNNER_ROOT}/.path"
  local temp_path_path="${path_path}.tmp"

  mkdir -p \
    "${RUNNER_HOME}/Library/Logs" \
    "${RUNNER_TMP}" \
    "${RUNNER_TEMP}" \
    "${RUNNER_TOOL_CACHE}" \
    "${LOCAL_BIN_DIR}" \
    "${NPM_GLOBAL_BIN}" \
    "${PNPM_HOME}" \
    "${COREPACK_HOME}" \
    "${PULUMI_HOME}"

  RUNNER_PATH="$(build_runner_path "${AMBIENT_PATH}")"

  {
    printf 'LANG=%q\n' "${LANG:-en_US.UTF-8}"
    printf 'HOME=%q\n' "${RUNNER_HOME}"
    printf 'TMPDIR=%q\n' "${RUNNER_TMP}"
    printf 'RUNNER_TEMP=%q\n' "${RUNNER_TEMP}"
    printf 'RUNNER_TOOL_CACHE=%q\n' "${RUNNER_TOOL_CACHE}"
    printf 'PNPM_HOME=%q\n' "${PNPM_HOME}"
    printf 'COREPACK_HOME=%q\n' "${COREPACK_HOME}"
    printf 'PULUMI_HOME=%q\n' "${PULUMI_HOME}"
  } > "${temp_env_path}"
  printf '%s\n' "${RUNNER_PATH}" > "${temp_path_path}"

  mv "${temp_env_path}" "${env_path}"
  mv "${temp_path_path}" "${path_path}"
}

write_env_file
