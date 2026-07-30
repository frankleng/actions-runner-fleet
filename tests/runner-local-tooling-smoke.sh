#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/provision-runner-tooling.sh"

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT

mkdir -p "${temp_dir}/_work/_tool/node/22.21.1/arm64/bin"
host_home="${temp_dir}/host-home"
mkdir -p "${host_home}/Library/pnpm" "${host_home}/setup-pnpm"

env_output="$(HOME="${host_home}" PATH="/usr/bin:/bin:${host_home}/Library/pnpm:/usr/sbin:${host_home}/setup-pnpm:/sbin:/Applications/Little Snitch.app/Contents/Components" /bin/bash "${SCRIPT_PATH}" --root "${temp_dir}" --dry-run --print-env)"
manifest_output="$(/bin/bash "${SCRIPT_PATH}" --root "${temp_dir}" --dry-run --print-manifest)"

printf '%s\n' "${env_output}" | grep -q "HOME=${temp_dir}/home"
printf '%s\n' "${env_output}" | grep -q "TMPDIR=${temp_dir}/tmp"
printf '%s\n' "${env_output}" | grep -q "RUNNER_TEMP=${temp_dir}/_work/_temp"
printf '%s\n' "${env_output}" | grep -q "RUNNER_TOOL_CACHE=${temp_dir}/_work/_tool"
printf '%s\n' "${env_output}" | grep -q "PNPM_HOME=${temp_dir}/tools/pnpm-global/bin"
printf '%s\n' "${env_output}" | grep -q "COREPACK_HOME=${temp_dir}/tools/corepack"
printf '%s\n' "${env_output}" | grep -q "PULUMI_HOME=${temp_dir}/tools/pulumi-home"
printf '%s\n' "${env_output}" | grep -q "PATH=${temp_dir}/tools/bin:${temp_dir}/tools/pnpm-global/bin:${temp_dir}/tools/npm-global/bin:${temp_dir}/_work/_tool/node/22.21.1/arm64/bin:"
if printf '%s\n' "${env_output}" | grep -Fq "${host_home}/Library/pnpm"; then
  echo "expected runner-local PATH to exclude the host pnpm directory"
  exit 1
fi
if printf '%s\n' "${env_output}" | grep -Fq "${host_home}/setup-pnpm"; then
  echo "expected runner-local PATH to exclude the host setup-pnpm directory"
  exit 1
fi

unset HOME TMPDIR RUNNER_TEMP RUNNER_TOOL_CACHE PNPM_HOME COREPACK_HOME PULUMI_HOME
eval "${env_output}"
[[ "${HOME}" == "${temp_dir}/home" ]]
[[ "${TMPDIR}" == "${temp_dir}/tmp" ]]
[[ "${RUNNER_TEMP}" == "${temp_dir}/_work/_temp" ]]
[[ "${RUNNER_TOOL_CACHE}" == "${temp_dir}/_work/_tool" ]]
[[ "${PNPM_HOME}" == "${temp_dir}/tools/pnpm-global/bin" ]]
[[ "${COREPACK_HOME}" == "${temp_dir}/tools/corepack" ]]
[[ "${PULUMI_HOME}" == "${temp_dir}/tools/pulumi-home" ]]
[[ "${PATH}" == "${temp_dir}/tools/bin:${temp_dir}/tools/pnpm-global/bin:${temp_dir}/tools/npm-global/bin:${temp_dir}/_work/_tool/node/22.21.1/arm64/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Applications/Little Snitch.app/Contents/Components" ]]

printf '%s\n' "${manifest_output}" | grep -q "RUNNER_TOOL_NODE_VERSION=22.21.1"
printf '%s\n' "${manifest_output}" | grep -q "RUNNER_TOOL_PNPM_VERSION=9.4.0"
printf '%s\n' "${manifest_output}" | grep -q "RUNNER_TOOL_WRANGLER_VERSION=4.69.0"
printf '%s\n' "${manifest_output}" | grep -q "RUNNER_TOOL_PULUMI_VERSION=3.143.0"
printf '%s\n' "${manifest_output}" | grep -q "RUNNER_TOOL_AWS_VERSION=2.36.11"

if [ -n "${HOME:-}" ] && grep -Fq "${HOME}" "${SCRIPT_PATH}" "${ROOT_DIR}/overlay/env.sh"; then
  echo "runner tooling must not contain a source-machine home path"
  exit 1
fi

if grep -Fq "/opt/homebrew/Cellar/awscli" "${SCRIPT_PATH}"; then
  echo "runner tooling must not depend on a Homebrew AWS CLI path"
  exit 1
fi
