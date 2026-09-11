#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${ROOT_DIR}/platform.sh"
OUTPUT_DIR="${1:-${ROOT_DIR}/dist}"
RUNNER_ARCHIVE_NAME="${RUNNER_ARCHIVE_BASENAME}"
RUNNER_ARCHIVE_PATH="${ROOT_DIR}/${RUNNER_ARCHIVE_NAME}"
FLEET_SOURCE_PATH="${RUNNER_FLEET_PATH:-${ROOT_DIR}/fleet.example.tsv}"
PACKAGE_NAME="actions-runner-fleet-kit-${RUNNER_PLATFORM}-${RUNNER_VERSION}"
PACKAGE_PATH="${OUTPUT_DIR}/${PACKAGE_NAME}.tar.gz"
CHECKSUM_PATH="${PACKAGE_PATH}.sha256"

fail() {
  echo "package build failed: $*" >&2
  exit 1
}

[ -f "${RUNNER_ARCHIVE_PATH}" ] ||
  fail "runner archive is missing: ${RUNNER_ARCHIVE_PATH}"
[ -f "${FLEET_SOURCE_PATH}" ] ||
  fail "fleet manifest is missing: ${FLEET_SOURCE_PATH}"

actual_checksum="$(runner_sha256 "${RUNNER_ARCHIVE_PATH}" | awk '{print $1}')"
[ "${actual_checksum}" = "${RUNNER_ARCHIVE_SHA256}" ] ||
  fail "runner archive checksum mismatch"

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT
package_root="${temp_dir}/${PACKAGE_NAME}"

mkdir -p "${package_root}/runnerctl-app" "${package_root}/patches" "${OUTPUT_DIR}"
mkdir -p "${package_root}/docs/images"

cp "${ROOT_DIR}/bootstrap.sh" "${package_root}/bootstrap.sh"
cp "${ROOT_DIR}/configure-host-temp.sh" "${package_root}/configure-host-temp.sh"
cp "${ROOT_DIR}/restore-fleet.sh" "${package_root}/restore-fleet.sh"
cp "${ROOT_DIR}/manage-runners.sh" "${package_root}/manage-runners.sh"
cp "${ROOT_DIR}/provision-runner-tooling.sh" "${package_root}/provision-runner-tooling.sh"
cp "${ROOT_DIR}/runnerctl" "${package_root}/runnerctl"
cp "${ROOT_DIR}/runner-target.sh" "${package_root}/runner-target.sh"
cp "${ROOT_DIR}/platform.sh" "${package_root}/platform.sh"
cp "${ROOT_DIR}/patches/cpulimit-0.2-macos.patch" "${package_root}/patches/cpulimit-0.2-macos.patch"
cp "${ROOT_DIR}/CLAUDE.md" "${package_root}/CLAUDE.md"
cp "${ROOT_DIR}/README.md" "${package_root}/README.md"
cp "${ROOT_DIR}/docs/images/runnerctl-dashboard-demo.png" \
  "${package_root}/docs/images/runnerctl-dashboard-demo.png"
cp "${ROOT_DIR}/docs/images/runnerctl-stats-demo.png" \
  "${package_root}/docs/images/runnerctl-stats-demo.png"
cp "${FLEET_SOURCE_PATH}" "${package_root}/fleet.tsv"
cp "${ROOT_DIR}/autoscale.example.json" "${package_root}/autoscale.example.json"
cp "${ROOT_DIR}/fleet.example.tsv" "${package_root}/fleet.example.tsv"
cp "${RUNNER_ARCHIVE_PATH}" "${package_root}/${RUNNER_ARCHIVE_NAME}"
# Deliberate file allowlist: never sweep source directories or local dependencies.
while IFS= read -r source_file; do
  [ ! -L "${ROOT_DIR}/${source_file}" ] || fail "source symlinks are not portable"
  mkdir -p "${package_root}/$(dirname "${source_file}")"
  cp "${ROOT_DIR}/${source_file}" "${package_root}/${source_file}"
done <<'PUBLIC_FILES'
overlay/autoscale-lock.mjs
overlay/autoscale-worker.mjs
overlay/bin/actions.runner.plist.template
overlay/bin/actions.runner.service.template
overlay/env.sh
overlay/runner-job-temp.sh
overlay/runsvc.sh
overlay/svc-systemd-user.sh
overlay/svc.sh
runnerctl-app/bin/runnerctl-autoscale.mjs
runnerctl-app/bin/runnerctl-dashboard.mjs
runnerctl-app/bin/runnerctl-stats.mjs
runnerctl-app/lib/runnerctl-autoscale-service.mjs
runnerctl-app/lib/runnerctl-autoscale.mjs
runnerctl-app/lib/runnerctl-core.mjs
runnerctl-app/lib/runnerctl-metrics.mjs
runnerctl-app/lib/runnerctl-stats.mjs
runnerctl-app/lib/runnerctl-table.mjs
runnerctl-app/native/runnerctl-procstats.c
PUBLIC_FILES
cp "${ROOT_DIR}/runnerctl-app/package.json" "${package_root}/runnerctl-app/package.json"
cp "${ROOT_DIR}/runnerctl-app/pnpm-lock.yaml" "${package_root}/runnerctl-app/pnpm-lock.yaml"

# Install from the lock in an empty staging tree; local node_modules is never copied.
pnpm --dir "${package_root}/runnerctl-app" install --prod --frozen-lockfile --ignore-scripts >/dev/null
# pnpm's local store metadata contains build-host paths and is unnecessary at runtime.
rm -f "${package_root}/runnerctl-app/node_modules/.modules.yaml" "${package_root}/runnerctl-app/node_modules/.pnpm-workspace-state-v1.json"

: > "${package_root}/runners.tsv"
printf '%s\n' "${RUNNER_VERSION}" > "${package_root}/VERSION"
chmod u+x \
  "${package_root}/bootstrap.sh" \
  "${package_root}/configure-host-temp.sh" \
  "${package_root}/restore-fleet.sh" \
  "${package_root}/manage-runners.sh" \
  "${package_root}/provision-runner-tooling.sh" \
  "${package_root}/runnerctl" \
  "${package_root}/runner-target.sh" \
  "${package_root}/platform.sh" \
  "${package_root}/overlay/env.sh" \
  "${package_root}/overlay/svc.sh" \
  "${package_root}/overlay/svc-systemd-user.sh" \
  "${package_root}/overlay/runsvc.sh"

if find "${package_root}" \
  \( -name '.credentials*' -o -name '.runner*' -o -name '.service' -o \
     -name '.autoscale*' -o -name 'autoscale.json' -o -name '.env' -o -name '.path' -o -name '_work' -o -name '_diag' \) \
  -print | grep -q .; then
  fail "package staging contains live runner state"
fi

if [ -n "${HOME:-}" ] && grep -R -I -Fq "${HOME}" "${package_root}"; then
  fail "package staging contains the source-machine home path"
fi

secret_pattern='-----BEGIN ([A-Z ]+)?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|sk_live_[A-Za-z0-9]{16,}|https://hooks\.slack\.com/services/[A-Za-z0-9/_-]{20,}'
if grep -R -I -l -E -e "${secret_pattern}" "${package_root}" >/dev/null 2>&1; then
  fail "package staging contains a potential credential format"
fi

COPYFILE_DISABLE=1 tar -czf "${PACKAGE_PATH}" -C "${temp_dir}" "${PACKAGE_NAME}"

(
  cd "${OUTPUT_DIR}"
  runner_sha256 "$(basename "${PACKAGE_PATH}")" > "$(basename "${CHECKSUM_PATH}")"
)

archive_listing="$(tar -tzf "${PACKAGE_PATH}")"
if printf '%s\n' "${archive_listing}" |
  grep -E '/(\.credentials[^/]*|\.runner[^/]*|\.service|\.autoscale[^/]*|autoscale\.json|\.env|\.path|_work|_diag)(/|$)' >/dev/null; then
  fail "built archive contains live runner state"
fi

echo "built ${PACKAGE_PATH}"
echo "checksum ${CHECKSUM_PATH}"
