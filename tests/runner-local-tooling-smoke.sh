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
printf '%s\n' "${env_output}" | grep -q "TMPDIR=${temp_dir}/tmp/managed-job"
printf '%s\n' "${env_output}" | grep -q "RUNNER_TEMP=${temp_dir}/_work/_temp"
printf '%s\n' "${env_output}" | grep -q "RUNNER_TOOL_CACHE=${tool_cache_dir}"
printf '%s\n' "${env_output}" | grep -q "PNPM_HOME=${temp_dir}/tools/pnpm-global"
printf '%s\n' "${env_output}" | grep -q "COREPACK_HOME=${host_tools_dir}/corepack"
printf '%s\n' "${env_output}" | grep -q "PULUMI_HOME=${host_tools_dir}/pulumi-home"
if printf '%s\n' "${env_output}" | grep -q '^CCACHE_'; then
  echo "expected ccache settings in the ccache wrapper, not the job environment"
  exit 1
fi
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
[[ "${TMPDIR}" == "${temp_dir}/tmp/managed-job" ]]
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
printf '%s\n' "${manifest_output}" | grep -q "RUNNER_TOOL_AWS_VERSION=2.36.22"
printf '%s\n' "${manifest_output}" | grep -q "RUNNER_TOOL_CPULIMIT_VERSION=0.2"
printf '%s\n' "${manifest_output}" | grep -q "RUNNER_TOOL_CCACHE_VERSION=4.14.2"

mkdir -p "${temp_dir}/job-hooks"
cp "${ROOT_DIR}/overlay/runner-job-temp.sh" "${temp_dir}/job-hooks/runner-job-started.sh"
cp "${ROOT_DIR}/overlay/runner-job-temp.sh" "${temp_dir}/job-hooks/runner-job-completed.sh"
printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=/custom/start.sh\nACTIONS_RUNNER_HOOK_JOB_COMPLETED=/custom/end.sh\n' > "${temp_dir}/.env"
run_provision --write-env
grep -qx 'RUNNER_PREVIOUS_JOB_STARTED_HOOK=/custom/start.sh' "${temp_dir}/.env"
grep -qx "ACTIONS_RUNNER_HOOK_JOB_STARTED=${temp_dir}/job-hooks/runner-job-started.sh" "${temp_dir}/.env"
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
grep -qx 'RUNNER_PREVIOUS_JOB_STARTED_HOOK=/custom/start.sh' "${temp_dir}/.env"
grep -qx 'RUNNER_PREVIOUS_JOB_COMPLETED_HOOK=/custom/end.sh' "${temp_dir}/.env"
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

# GitHub's config.sh sources env.sh; it must keep running afterward to configure or remove.
env_check_dir="$(mktemp -d)"
cp "${ROOT_DIR}/overlay/env.sh" "${env_check_dir}/env.sh"
printf '#!/bin/bash\ntouch "%s/provisioned"\n' "${env_check_dir}" > "${env_check_dir}/provision"
printf '#!/bin/bash\ncd "$(dirname "$0")"\nsource ./env.sh\ntouch configured\n' > "${env_check_dir}/config.sh"
chmod +x "${env_check_dir}/env.sh" "${env_check_dir}/provision" "${env_check_dir}/config.sh"
RUNNER_PROVISION_SCRIPT_PATH="${env_check_dir}/provision" bash "${env_check_dir}/config.sh"
if [ ! -f "${env_check_dir}/provisioned" ] || [ ! -f "${env_check_dir}/configured" ]; then
  echo "sourcing env.sh must provision and then return to config.sh"
  exit 1
fi
rm -rf "${env_check_dir}"

# Xcode starts compiler tasks with its own environment, so the ccache wrapper
# must carry the cache settings itself. A stub binary stands in for the pinned
# download, and an empty environment stands in for Xcode's.
if [ "${RUNNER_SERVICE_MANAGER}" = "launchd" ]; then
  ccache_check_dir="$(mktemp -d)"
  ccache_host_tools="${ccache_check_dir}/host-tools"
  ccache_stub="${ccache_host_tools}/ccache/4.14.2/ccache"
  mkdir -p "$(dirname "${ccache_stub}")" "${ccache_check_dir}/runner/tools/bin" "${ccache_check_dir}/no-network"
  # Stands in for ccache's size parser: "lots" is invalid and "0" is unlimited.
  cat > "${ccache_stub}" <<'STUB'
#!/bin/sh
case "$1" in
  --version) exit 0 ;;
  --get-config)
    case "${CCACHE_MAXSIZE}" in
      lots) exit 1 ;;
      0) echo 0 ;;
      *) echo "${CCACHE_MAXSIZE}" ;;
    esac
    exit 0
    ;;
esac
printf '%s\n' "dir=${CCACHE_DIR}" "base=${CCACHE_BASEDIR}" "max=${CCACHE_MAXSIZE}" "check=${CCACHE_COMPILERCHECK}" "args=$*"
STUB
  chmod +x "${ccache_stub}"
  # Any attempt to download fails, so a broken binary cannot be replaced here.
  printf '#!/bin/sh\nexit 1\n' > "${ccache_check_dir}/no-network/curl"
  chmod +x "${ccache_check_dir}/no-network/curl"
  # An older provisioning run left a plain symlink; the wrapper must replace it.
  ln -s "${ccache_stub}" "${ccache_check_dir}/runner/tools/bin/ccache"

  install_ccache_for_test() (
    source "${ROOT_DIR}/platform.sh"
    eval "$(awk '/^write_ccache_wrapper\(\) \{/,/^\}/; /^ccache_binary_runs\(\) \{/,/^\}/; /^install_ccache\(\) \{/,/^\}/' "${SCRIPT_PATH}")"
    PATH="${ccache_check_dir}/no-network:${PATH}"
    DRY_RUN=0
    ROOT_DIR="${ccache_check_dir}/runner"
    HOST_TOOLS_DIR="${ccache_host_tools}"
    LOCAL_BIN_DIR="${ROOT_DIR}/tools/bin"
    CCACHE_VERSION="4.14.2"
    CCACHE_DARWIN_SHA256="unused"
    CCACHE_INSTALL_DIR="${HOST_TOOLS_DIR}/ccache/${CCACHE_VERSION}"
    CCACHE_BIN_PATH="${CCACHE_INSTALL_DIR}/ccache"
    CCACHE_STORE_DIR="${HOST_TOOLS_DIR}/ccache-store"
    CCACHE_MAX_SIZE="$1"
    install_ccache
  )

  for rejected_size in lots 0; do
    if install_ccache_for_test "${rejected_size}" >/dev/null 2>&1; then
      echo "expected provisioning to reject ccache size '${rejected_size}'"
      exit 1
    fi
  done
  [ -L "${ccache_check_dir}/runner/tools/bin/ccache" ] || {
    echo "a rejected size must leave the existing ccache entry untouched"
    exit 1
  }

  install_ccache_for_test 3G
  [ ! -L "${ccache_check_dir}/runner/tools/bin/ccache" ]
  [ -d "${ccache_host_tools}/ccache-store" ]
  wrapper_output="$(env -i "${ccache_check_dir}/runner/tools/bin/ccache" clang -c a.c)"
  [ "${wrapper_output}" = "dir=${ccache_host_tools}/ccache-store
base=${ccache_check_dir}/runner
max=3G
check=%compiler% -v
args=clang -c a.c" ] || {
    printf 'unexpected ccache wrapper environment:\n%s\n' "${wrapper_output}"
    exit 1
  }

  # A binary that no longer runs must be replaced before the wrapper is
  # rewritten. With no download possible, provisioning fails and removes the
  # wrapper written above, so builds fall back to running uncached.
  # Fails only its health check, so nothing else can stop provisioning first.
  printf '#!/bin/sh\n[ "$1" = --version ] && exit 1\necho 3G\n' > "${ccache_stub}"
  if install_ccache_for_test 3G >/dev/null 2>&1; then
    echo "expected provisioning to fail when the installed ccache does not run"
    exit 1
  fi
  [ ! -e "${ccache_check_dir}/runner/tools/bin/ccache" ] || {
    echo "a broken ccache binary must not keep a wrapper"
    exit 1
  }
  rm -rf "${ccache_check_dir}"
fi
