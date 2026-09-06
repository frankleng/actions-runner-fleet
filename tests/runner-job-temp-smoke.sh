#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Deliberately avoid /tmp: this test must run even when its inodes are full.
test_root="$(mktemp -d "${ROOT_DIR}/.job-temp-test.XXXXXX")"
trap 'rm -rf "${test_root}"' EXIT
mkdir -p "${test_root}/bin" "${test_root}/job-hooks" "${test_root}/tmp/managed-job/nested" "${test_root}/outside"
cp "${ROOT_DIR}/overlay/runner-job-temp.sh" "${test_root}/job-hooks/runner-job-started.sh"
cp "${ROOT_DIR}/overlay/runner-job-temp.sh" "${test_root}/job-hooks/runner-job-completed.sh"
printf keep > "${test_root}/outside/keep"
printf keep > "${test_root}/tmp/unmanaged"
printf stale > "${test_root}/tmp/managed-job/nested/.hidden"
ln -s "${test_root}/outside" "${test_root}/tmp/managed-job/link"
bash "${test_root}/job-hooks/runner-job-started.sh"
[ -z "$(ls -A "${test_root}/tmp/managed-job")" ]
[ -f "${test_root}/outside/keep" ]
[ -f "${test_root}/tmp/unmanaged" ]
printf job > "${test_root}/tmp/managed-job/current"
printf '[ -f "${TMPDIR}/current" ] || exit 99\nexit 7\n' > "${test_root}/previous.sh"
status=0
TMPDIR="${test_root}/tmp/managed-job" RUNNER_PREVIOUS_JOB_COMPLETED_HOOK="${test_root}/previous.sh" \
  bash "${test_root}/job-hooks/runner-job-completed.sh" || status=$?
[ "${status}" -eq 7 ]
[ -z "$(ls -A "${test_root}/tmp/managed-job")" ]
rmdir "${test_root}/tmp/managed-job"
ln -s "${test_root}/outside" "${test_root}/tmp/managed-job"
if bash "${test_root}/job-hooks/runner-job-started.sh"; then
  echo 'Expected symlink guard to reject cleanup' >&2
  exit 1
fi
[ -f "${test_root}/outside/keep" ]
rm "${test_root}/tmp/managed-job"
mkdir -p "${test_root}/externals/node20/bin"
cp "${ROOT_DIR}/overlay/runsvc.sh" "${test_root}/runsvc.sh"
cat > "${test_root}/externals/node20/bin/node" <<'NODE'
#!/bin/bash
set -euo pipefail
[ "${TMPDIR}" = "${PWD}/tmp/managed-job" ]
[ "${TMP}" = "${TMPDIR}" ] && [ "${TEMP}" = "${TMPDIR}" ]
printf stale > "${TMPDIR}/stale"
bash "${ACTIONS_RUNNER_HOOK_JOB_STARTED}"
[ ! -e "${TMPDIR}/stale" ]
printf active > "${TMPDIR}/active"
sleep 0.1
[ -f "${TMPDIR}/active" ]
bash "${ACTIONS_RUNNER_HOOK_JOB_COMPLETED}"
[ ! -e "${TMPDIR}/active" ]
touch ./listener-tested
NODE
chmod +x "${test_root}/externals/node20/bin/node"
if [ "$(uname -s)" = Linux ]; then
  (cd "${test_root}" && RUNNER_LOG_PRUNE_INTERVAL_SECONDS=0 bash ./runsvc.sh)
  [ -f "${test_root}/listener-tested" ]

  ln -s "${test_root}" "${test_root}/alias"
  RUNNER_PREVIOUS_JOB_STARTED_HOOK="${test_root}/alias/job-hooks/runner-job-started.sh" \
    bash "${test_root}/job-hooks/runner-job-started.sh"
  printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s/alias/job-hooks/runner-job-started.sh\nRUNNER_PREVIOUS_JOB_STARTED_HOOK=\n' "${test_root}" > "${test_root}/.env"
  (cd "${test_root}" && RUNNER_LOG_PRUNE_INTERVAL_SECONDS=0 bash ./runsvc.sh)
  printf 'touch ./ambient-hook-tested\n' > "${test_root}/ambient.sh"
  (cd "${test_root}" && ACTIONS_RUNNER_HOOK_JOB_STARTED="${test_root}/ambient.sh" \
    RUNNER_LOG_PRUNE_INTERVAL_SECONDS=0 bash ./runsvc.sh)
  [ -f "${test_root}/ambient-hook-tested" ]

  # Simulate find's EBUSY/permission failure without requiring mount privileges.
  mkdir "${test_root}/stubs"
  printf '#!/bin/sh\nexit 1\n' > "${test_root}/stubs/find"
  chmod +x "${test_root}/stubs/find"
  PATH="${test_root}/stubs:${PATH}" bash "${test_root}/job-hooks/runner-job-started.sh" 2> "${test_root}/warning"
  grep -q 'Warning: some runner scratch files' "${test_root}/warning"
fi
echo 'Runner job temporary cleanup smoke test passed'
