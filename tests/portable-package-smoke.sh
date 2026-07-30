#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_SCRIPT="${ROOT_DIR}/build-portable-package.sh"
PACKAGE_NAME="actions-runner-fleet-kit-macos-arm64-2.336.0"

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT

fleet_path="${temp_dir}/fleet.tsv"
output_dir="${temp_dir}/dist"
extract_dir="${temp_dir}/extract"
package_path="${output_dir}/${PACKAGE_NAME}.tar.gz"
checksum_path="${package_path}.sha256"

cat > "${fleet_path}" <<'EOF'
# token-key	GitHub target URL	runner name
MY_ORG	https://github.com/example-org	mac-runner-1
MY_ORG	https://github.com/example-org	mac-runner-2
MY_REPO	https://github.com/example-user/example-repo	repo-runner-1
MY_ENTERPRISE	https://github.com/enterprises/example-enterprise	enterprise-runner-1
EOF

RUNNER_FLEET_PATH="${fleet_path}" /bin/bash "${BUILD_SCRIPT}" "${output_dir}"

[ -f "${package_path}" ]
[ -f "${checksum_path}" ]
(
  cd "${output_dir}"
  shasum -a 256 -c "$(basename "${checksum_path}")"
)

mkdir -p "${extract_dir}"
tar -xzf "${package_path}" -C "${extract_dir}"
package_root="${extract_dir}/${PACKAGE_NAME}"

[ -f "${package_root}/runners.tsv" ]
[ ! -s "${package_root}/runners.tsv" ]
[ -f "${package_root}/fleet.tsv" ]
[ -f "${package_root}/fleet.example.tsv" ]
[ -f "${package_root}/CLAUDE.md" ]
[ -f "${package_root}/runner-target.sh" ]
[ -f "${package_root}/runnerctl-app/native/runnerctl-procstats.c" ]
[ "$(awk -F '\t' '$1 !~ /^#/ && NF >= 3 { count += 1 } END { print count + 0 }' "${package_root}/fleet.tsv")" -eq 4 ]

for script_path in \
  "${package_root}/bootstrap.sh" \
  "${package_root}/restore-fleet.sh" \
  "${package_root}/manage-runners.sh" \
  "${package_root}/provision-runner-tooling.sh" \
  "${package_root}/runnerctl" \
  "${package_root}/runner-target.sh" \
  "${package_root}/overlay/env.sh" \
  "${package_root}/overlay/svc.sh" \
  "${package_root}/overlay/runsvc.sh"; do
  [ -x "${script_path}" ]
  /bin/bash -n "${script_path}"
done

if find "${package_root}" \
  \( -name '.credentials*' -o -name '.runner*' -o -name '.service' -o \
     -name '.env' -o -name '.path' -o -name '_work' -o -name '_diag' \) \
  -print | grep -q .; then
  echo "portable package contains live runner state"
  exit 1
fi

if [ -n "${HOME:-}" ] && grep -R -I -Fq "${HOME}" "${package_root}"; then
  echo "portable package contains the source-machine home path"
  exit 1
fi

if find "${package_root}" -path '*/host-tools/*' -print | grep -q .; then
  echo "portable package must not bundle host-downloaded tools such as AWS CLI"
  exit 1
fi

dashboard_help="$(
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" "${package_root}/runnerctl" --help
)"
grep -q "Auto-refresh" <<< "${dashboard_help}"
[ -x "${package_root}/host-tools/node24/bin/node" ]
[ -x "${package_root}/host-tools/runnerctl-procstats" ]

stats_help="$("${package_root}/runnerctl" stats --help)"
grep -q "Markdown table by default" <<< "${stats_help}"

check_output="$("${package_root}/bootstrap.sh" --check)"
grep -q "portable runner kit is ready" <<< "${check_output}"

dry_run_output="$(
  RUNNER_REGISTRY_PATH="${temp_dir}/portable-runners.tsv" \
  RUNNER_DIRECTORY_PREFIX="${temp_dir}/actions-runner" \
    "${package_root}/restore-fleet.sh" --dry-run
)"
grep -q "mac-runner-1" <<< "${dry_run_output}"
grep -q "repo-runner-1" <<< "${dry_run_output}"
grep -q "enterprise-runner-1" <<< "${dry_run_output}"
grep -q "enterprise target" <<< "${dry_run_output}"
grep -q "fleet restore dry run complete" <<< "${dry_run_output}"

credential_fleet="${temp_dir}/credential-fleet.tsv"
{
  echo "# This is an intentionally fake test value matching a known credential format."
  printf '# %s%s\n' 'github_pat_' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  printf 'MY_ORG\thttps://github.com/example-org\tmac-runner-1\n'
} > "${credential_fleet}"

if RUNNER_FLEET_PATH="${credential_fleet}" \
  /bin/bash "${BUILD_SCRIPT}" "${temp_dir}/credential-dist" \
  >/dev/null 2>"${temp_dir}/credential.err"; then
  echo "expected package build to reject a credential-shaped value"
  exit 1
fi
grep -q "potential credential format" "${temp_dir}/credential.err"
