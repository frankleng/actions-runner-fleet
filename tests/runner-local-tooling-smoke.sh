#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "${ROOT_DIR}/platform.sh"
SCRIPT_PATH="${ROOT_DIR}/provision-runner-tooling.sh"
behavior_pnpm_bin="$(command -v pnpm || true)"
behavior_node_bin="$(command -v node || true)"
behavior_corepack_home="${COREPACK_HOME:-${HOME}/.cache/node/corepack}"

[ -n "${behavior_pnpm_bin}" ] && [ -n "${behavior_node_bin}" ] || {
  echo "node and pnpm are required for the runner-local tooling behavioral smoke test"
  exit 1
}

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT

host_tools_dir="${temp_dir}/host-tools"
pnpm_store_dir="${temp_dir}/pnpm-store"
tool_cache_dir="${host_tools_dir}/tool-cache"
mkdir -p "${tool_cache_dir}/node/24.19.0/${RUNNER_NODE_ARCH}/bin"
ln -s "${behavior_node_bin}" "${tool_cache_dir}/node/24.19.0/${RUNNER_NODE_ARCH}/bin/node"
mkdir -p "${host_tools_dir}/pnpm-tools/bin" "${temp_dir}/tools/bin"
cat > "${host_tools_dir}/pnpm-tools/bin/wrangler" <<'EOF'
#!/bin/sh
basedir="$(dirname "$0")"
cat "${basedir}/../wrangler-version"
EOF
chmod u+x "${host_tools_dir}/pnpm-tools/bin/wrangler"
printf '4.69.0\n' > "${host_tools_dir}/pnpm-tools/wrangler-version"

# Reproduce the original migration bug: pnpm's launcher works at its shared
# path, but a symlink changes $0 and makes its relative module lookup fail.
ln -s "${host_tools_dir}/pnpm-tools/bin/wrangler" "${temp_dir}/tools/bin/wrangler"
if "${temp_dir}/tools/bin/wrangler" --version >/dev/null 2>&1; then
  echo "expected the relocated pnpm launcher symlink to fail"
  exit 1
fi
host_home="${temp_dir}/host-home"
mkdir -p "${host_home}/Library/pnpm" "${host_home}/setup-pnpm"

run_provision() {
  HOME="${host_home}" \
  PATH="/usr/bin:/bin:${host_home}/Library/pnpm:/usr/sbin:${host_home}/setup-pnpm:/sbin:/Applications/Little Snitch.app/Contents/Components" \
  RUNNER_HOST_TOOLS_DIR="${host_tools_dir}" \
  RUNNER_PNPM_STORE_DIR="${pnpm_store_dir}" \
    /bin/bash "${SCRIPT_PATH}" --root "${temp_dir}" "$@"
}

env_output="$(run_provision --dry-run --print-env)"
manifest_output="$(run_provision --dry-run --print-manifest)"

printf '%s\n' "${env_output}" | grep -q "HOME=${temp_dir}/home"
printf '%s\n' "${env_output}" | grep -q "TMPDIR=${temp_dir}/tmp"
printf '%s\n' "${env_output}" | grep -q "RUNNER_TEMP=${temp_dir}/_work/_temp"
printf '%s\n' "${env_output}" | grep -q "RUNNER_TOOL_CACHE=${tool_cache_dir}"
printf '%s\n' "${env_output}" | grep -q "PNPM_HOME=${temp_dir}/tools/pnpm-global"
printf '%s\n' "${env_output}" | grep -q "COREPACK_HOME=${host_tools_dir}/corepack"
printf '%s\n' "${env_output}" | grep -q "PULUMI_HOME=${host_tools_dir}/pulumi-home"
printf '%s\n' "${env_output}" | grep -q "PATH=${temp_dir}/tools/bin:${temp_dir}/tools/pnpm-global:${temp_dir}/tools/pnpm-global/bin:${tool_cache_dir}/node/24.19.0/${RUNNER_NODE_ARCH}/bin:"
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
[[ "${RUNNER_TOOL_CACHE}" == "${tool_cache_dir}" ]]
[[ "${PNPM_HOME}" == "${temp_dir}/tools/pnpm-global" ]]
[[ "${COREPACK_HOME}" == "${host_tools_dir}/corepack" ]]
[[ "${PULUMI_HOME}" == "${host_tools_dir}/pulumi-home" ]]
[[ "${PATH}" == "${temp_dir}/tools/bin:${temp_dir}/tools/pnpm-global:${temp_dir}/tools/pnpm-global/bin:${tool_cache_dir}/node/24.19.0/${RUNNER_NODE_ARCH}/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Applications/Little Snitch.app/Contents/Components" ]]

printf '%s\n' "${manifest_output}" | grep -q "RUNNER_TOOL_NODE_VERSION=24.19.0"
printf '%s\n' "${manifest_output}" | grep -q "RUNNER_TOOL_PNPM_VERSION=11.20.0"
printf '%s\n' "${manifest_output}" | grep -q "RUNNER_TOOL_WRANGLER_VERSION=4.69.0"
printf '%s\n' "${manifest_output}" | grep -q "RUNNER_TOOL_PULUMI_VERSION=3.143.0"
printf '%s\n' "${manifest_output}" | grep -q "RUNNER_TOOL_AWS_VERSION=2.36.11"
printf '%s\n' "${manifest_output}" | grep -q "RUNNER_TOOL_CPULIMIT_VERSION=0.2"

run_provision --write-env
[ -f "${temp_dir}/.env" ]
[ -f "${temp_dir}/.path" ]
[ -x "${temp_dir}/tools/bin/wrangler" ]
[ ! -L "${temp_dir}/tools/bin/wrangler" ]
[ "$("${temp_dir}/tools/bin/wrangler" --version)" = "4.69.0" ]
grep -q "RUNNER_TOOL_CACHE=${tool_cache_dir}" "${temp_dir}/.env"
grep -q "^${temp_dir}/tools/bin:" "${temp_dir}/.path"
grep -qx "store-dir=${pnpm_store_dir}" "${temp_dir}/home/.npmrc"
grep -qx "cache=${host_tools_dir}/npm-cache" "${temp_dir}/home/.npmrc"

# Exercise pnpm's own global-bin resolution. PNPM_HOME is a data root, and
# pnpm appends /bin when global-bin-dir is not explicitly configured.
resolved_global_bin="$(
  HOME="${HOME}" \
  PNPM_HOME="${PNPM_HOME}" \
  PATH="${PATH}" \
  COREPACK_HOME="${behavior_corepack_home}" \
  "${behavior_pnpm_bin}" bin --global
)"
[[ "${resolved_global_bin}" == "${PNPM_HOME}/bin" ]]
case ":${PATH}:" in
  *":${resolved_global_bin}:"*) ;;
  *)
    echo "pnpm's resolved global bin is missing from runner PATH: ${resolved_global_bin}"
    exit 1
    ;;
esac
[ -d "${resolved_global_bin}" ]
[ -w "${resolved_global_bin}" ]

# --write-env must replace stale managed lines rather than stacking duplicates.
printf 'store-dir=/somewhere/stale\ncache=/somewhere/stale\nglobal-bin-dir=/somewhere/wrong/bin\nglobal-dir=/somewhere/wrong/global\nprefix=/somewhere/wrong\nregistry=https://registry.example.com\n' > "${temp_dir}/home/.npmrc"
mkdir -p "${temp_dir}/home/.config/pnpm"
printf 'global-bin-dir: /somewhere/wrong/bin\nglobalDir: /somewhere/wrong/global\nprefix: /somewhere/wrong\nverify-store-integrity: true\n' > "${temp_dir}/home/.config/pnpm/config.yaml"
run_provision --write-env
grep -qx "store-dir=${pnpm_store_dir}" "${temp_dir}/home/.npmrc"
grep -qx "cache=${host_tools_dir}/npm-cache" "${temp_dir}/home/.npmrc"
grep -qx "registry=https://registry.example.com" "${temp_dir}/home/.npmrc"
[ "$(grep -c '^store-dir=' "${temp_dir}/home/.npmrc")" -eq 1 ]
[ "$(grep -c '^cache=' "${temp_dir}/home/.npmrc")" -eq 1 ]
if grep -Eq '^(global-bin-dir|global-dir|prefix)=' "${temp_dir}/home/.npmrc"; then
  echo "expected runner provisioning to remove stale pnpm path overrides from .npmrc"
  exit 1
fi
if grep -Eq '^(global-bin-dir|global-dir|globalBinDir|globalDir|prefix):([[:space:]]|$)' "${temp_dir}/home/.config/pnpm/config.yaml"; then
  echo "expected runner provisioning to remove stale pnpm path overrides from global config"
  exit 1
fi
grep -qx 'verify-store-integrity: true' "${temp_dir}/home/.config/pnpm/config.yaml"

if [ -n "${HOME:-}" ] && grep -Fq "${HOME}" "${SCRIPT_PATH}" "${ROOT_DIR}/overlay/env.sh"; then
  echo "runner tooling must not contain a source-machine home path"
  exit 1
fi

if grep -Fq "/opt/homebrew/Cellar/awscli" "${SCRIPT_PATH}"; then
  echo "runner tooling must not depend on a Homebrew AWS CLI path"
  exit 1
fi
