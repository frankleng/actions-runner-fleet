#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${1:-${ROOT_DIR}/dist}"
RUNNER_VERSION="2.336.0"
RUNNER_ARCHIVE_NAME="actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"
RUNNER_ARCHIVE_PATH="${ROOT_DIR}/${RUNNER_ARCHIVE_NAME}"
RUNNER_ARCHIVE_SHA256="8e8839c49b7060b6b2154f4931f815df330c27f167d53ef2239ee3dfce28b079"
FLEET_SOURCE_PATH="${RUNNER_FLEET_PATH:-${ROOT_DIR}/fleet.tsv}"
PACKAGE_NAME="actions-runner-fleet-kit-macos-arm64-${RUNNER_VERSION}"
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

actual_checksum="$(shasum -a 256 "${RUNNER_ARCHIVE_PATH}" | awk '{print $1}')"
[ "${actual_checksum}" = "${RUNNER_ARCHIVE_SHA256}" ] ||
  fail "runner archive checksum mismatch"

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT
package_root="${temp_dir}/${PACKAGE_NAME}"

mkdir -p "${package_root}/runnerctl-app" "${OUTPUT_DIR}"

cp "${ROOT_DIR}/bootstrap.sh" "${package_root}/bootstrap.sh"
cp "${ROOT_DIR}/restore-fleet.sh" "${package_root}/restore-fleet.sh"
cp "${ROOT_DIR}/manage-runners.sh" "${package_root}/manage-runners.sh"
cp "${ROOT_DIR}/provision-runner-tooling.sh" "${package_root}/provision-runner-tooling.sh"
cp "${ROOT_DIR}/runnerctl" "${package_root}/runnerctl"
cp "${ROOT_DIR}/README.md" "${package_root}/README.md"
cp "${FLEET_SOURCE_PATH}" "${package_root}/fleet.tsv"
cp "${ROOT_DIR}/fleet.example.tsv" "${package_root}/fleet.example.tsv"
cp "${RUNNER_ARCHIVE_PATH}" "${package_root}/${RUNNER_ARCHIVE_NAME}"
cp -R "${ROOT_DIR}/overlay" "${package_root}/overlay"
cp -R "${ROOT_DIR}/runnerctl-app/bin" "${package_root}/runnerctl-app/bin"
cp -R "${ROOT_DIR}/runnerctl-app/lib" "${package_root}/runnerctl-app/lib"
cp -R "${ROOT_DIR}/runnerctl-app/node_modules" "${package_root}/runnerctl-app/node_modules"
cp "${ROOT_DIR}/runnerctl-app/package.json" "${package_root}/runnerctl-app/package.json"
cp "${ROOT_DIR}/runnerctl-app/package-lock.json" "${package_root}/runnerctl-app/package-lock.json"

: > "${package_root}/runners.tsv"
printf '%s\n' "${RUNNER_VERSION}" > "${package_root}/VERSION"
chmod u+x \
  "${package_root}/bootstrap.sh" \
  "${package_root}/restore-fleet.sh" \
  "${package_root}/manage-runners.sh" \
  "${package_root}/provision-runner-tooling.sh" \
  "${package_root}/runnerctl" \
  "${package_root}/overlay/env.sh" \
  "${package_root}/overlay/svc.sh" \
  "${package_root}/overlay/runsvc.sh"

if find "${package_root}" \
  \( -name '.credentials*' -o -name '.runner*' -o -name '.service' -o \
     -name '.env' -o -name '.path' -o -name '_work' -o -name '_diag' \) \
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
  shasum -a 256 "$(basename "${PACKAGE_PATH}")" > "$(basename "${CHECKSUM_PATH}")"
)

archive_listing="$(tar -tzf "${PACKAGE_PATH}")"
if printf '%s\n' "${archive_listing}" |
  grep -E '/(\.credentials[^/]*|\.runner[^/]*|\.service|\.env|\.path|_work|_diag)(/|$)' >/dev/null; then
  fail "built archive contains live runner state"
fi

echo "built ${PACKAGE_PATH}"
echo "checksum ${CHECKSUM_PATH}"
