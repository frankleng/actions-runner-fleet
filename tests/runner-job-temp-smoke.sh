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

  # A desktop session's agents, bus, display, and API keys must not reach the
  # listener, and so any job; the service's own settings must.
  cat > "${test_root}/externals/node20/bin/node" <<'NODE'
#!/bin/bash
env > ./listener-environment
declare -F > ./listener-functions
NODE
  printf 'HOME=%s/home\n' "${test_root}" > "${test_root}/.env"
  printf '/usr/bin:/bin\n' > "${test_root}/.path"
  fake_home="${test_root}/fake-home"
  mkdir -p "${fake_home}/.local/bin"
  leaked_session_function() { :; }
  export -f leaked_session_function
  (cd "${test_root}" && \
    env 'SESSION.ODD-NAME=leak' \
    HOME="${fake_home}" PATH="${fake_home}/.local/bin:${PATH}" \
    SSH_AUTH_SOCK="${fake_home}/agent.sock" SSH_AGENT_PID=1 \
    GPG_AGENT_INFO="${fake_home}/S.gpg-agent:0:1" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=${fake_home}/bus" \
    DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 XAUTHORITY="${fake_home}/.Xauthority" \
    XDG_RUNTIME_DIR="${fake_home}/run" XDG_SESSION_ID=2 \
    CLIPROXY_API_KEY=not-a-real-key \
    https_proxy=http://proxy.invalid:3128 RUNNER_SMOKE_SETTING=kept LANG=C.UTF-8 \
    RUNNER_LOG_PRUNE_INTERVAL_SECONDS=0 bash ./runsvc.sh)
  unset -f leaked_session_function
  for leaked in SSH_AUTH_SOCK SSH_AGENT_PID GPG_AGENT_INFO DBUS_SESSION_BUS_ADDRESS DISPLAY \
      WAYLAND_DISPLAY XAUTHORITY XDG_RUNTIME_DIR XDG_SESSION_ID CLIPROXY_API_KEY SESSION.ODD-NAME \
      BASH_FUNC_leaked_session_function; do
    if grep -q "^${leaked}" "${test_root}/listener-environment"; then
      echo "session variable ${leaked} reached the listener" >&2
      exit 1
    fi
  done
  if grep -q leaked_session_function "${test_root}/listener-functions"; then
    echo 'an exported session function reached the listener' >&2
    exit 1
  fi
  if grep -q "^PATH=.*${fake_home}" "${test_root}/listener-environment"; then
    echo 'the session PATH reached the listener' >&2
    exit 1
  fi
  grep -qx "HOME=${test_root}/home" "${test_root}/listener-environment"
  grep -qx 'PATH=/usr/bin:/bin' "${test_root}/listener-environment"
  grep -qx 'https_proxy=http://proxy.invalid:3128' "${test_root}/listener-environment"
  grep -qx 'RUNNER_SMOKE_SETTING=kept' "${test_root}/listener-environment"
  grep -qx 'LANG=C.UTF-8' "${test_root}/listener-environment"
  grep -qx "TMPDIR=${test_root}/tmp/managed-job" "${test_root}/listener-environment"
  grep -qx "ACTIONS_RUNNER_HOOK_JOB_STARTED=${test_root}/job-hooks/runner-job-started.sh" "${test_root}/listener-environment"
  rm -f "${test_root}/.env" "${test_root}/.path"

  # Simulate find's EBUSY/permission failure without requiring mount privileges.
  mkdir "${test_root}/stubs"
  printf '#!/bin/sh\nexit 1\n' > "${test_root}/stubs/find"
  chmod +x "${test_root}/stubs/find"
  PATH="${test_root}/stubs:${PATH}" bash "${test_root}/job-hooks/runner-job-started.sh" 2> "${test_root}/warning"
  grep -q 'Warning: some runner scratch files' "${test_root}/warning"
  rm -rf "${test_root}/stubs"

  # Persistent runners: the hooks contain each job in the service's runner-job
  # cgroup and stop what the job left behind, setsid and double-forked
  # processes included, but never the worker or the service's own processes.
  # Needs a cgroup v2 directory this account owns, as a systemd user manager
  # delegates; elsewhere (hosted CI) this part is skipped.
  own_cgroup="$(sed -n 's/^0:://p' /proc/self/cgroup)"
  service_cgroup="/sys/fs/cgroup${own_cgroup}/job-hook-test-$$.service"
  if [ -n "${own_cgroup}" ] && [ "${own_cgroup}" != / ] && mkdir "${service_cgroup}" 2>/dev/null; then
    remove_test_cgroup() {
      echo 1 > "${service_cgroup}/cgroup.kill" 2>/dev/null || true
      for _ in $(seq 50); do grep -qx 'populated 0' "${service_cgroup}/cgroup.events" && break; sleep 0.1; done
      rmdir "${service_cgroup}/runner-job" "${service_cgroup}" 2>/dev/null || true
      rm -rf "${test_root}"
    }
    trap remove_test_cgroup EXIT
    job_cgroup="${service_cgroup}/runner-job"
    in_cgroup() { [ "$(cat "/proc/$2/cgroup" 2>/dev/null)" = "0::${1#/sys/fs/cgroup}" ]; }
    mkdir -p "${test_root}/worker-bin" "${test_root}/_diag"
    cat > "${test_root}/worker-bin/Runner.Worker" <<'WORKER'
#!/bin/bash
# One job: the started hook, a step that leaves processes behind, the
# completed hook, then a straggler forked after it.
set -euo pipefail
bash ./job-hooks/runner-job-started.sh
setsid bash -c '(exec -a hook-grandchild sleep 300 &); exec -a hook-leader sleep 300' < /dev/null > /dev/null 2>&1 &
( trap '' TERM; exec -a hook-stubborn sleep 300 ) < /dev/null > /dev/null 2>&1 &
sleep 0.3
pgrep -f -x 'hook-(grandchild|leader|stubborn) 300' > job-leftovers
bash ./job-hooks/runner-job-completed.sh
echo "$$" > worker-survived-hook
( exec -a hook-straggler sleep 300 ) < /dev/null > /dev/null 2>&1 &
echo "$!" > straggler
WORKER
    chmod +x "${test_root}/worker-bin/Runner.Worker"
    # Stand-in for the launcher's log pruner, in the service cgroup itself.
    /bin/sh -c 'echo 0 > "$0/cgroup.procs" && exec sleep 300' "${service_cgroup}" &
    bystander=$!
    (cd "${test_root}" && /bin/sh -c 'echo 0 > "$0/cgroup.procs" && exec ./worker-bin/Runner.Worker' "${service_cgroup}")
    [ "$(wc -l < "${test_root}/job-leftovers")" -eq 3 ]
    for pid in $(cat "${test_root}/job-leftovers"); do
      if kill -0 "${pid}" 2>/dev/null; then echo "leftover job process ${pid} survived the completed hook" >&2; exit 1; fi
    done
    [ -s "${test_root}/worker-survived-hook" ]
    grep -q 'stopped 3 leftover process(es): sleep x3; 1 needed SIGKILL' "${test_root}/_diag/runner-job-cleanup.log"
    straggler="$(cat "${test_root}/straggler")"
    in_cgroup "${job_cgroup}" "${straggler}"
    kill -0 "${bystander}"
    # The next job's started hook removes what the previous one forked late.
    : > "${test_root}/_diag/runner-job-cleanup.log"
    (cd "${test_root}" && /bin/sh -c 'echo 0 > "$0/cgroup.procs" && exec ./worker-bin/Runner.Worker' "${service_cgroup}")
    if kill -0 "${straggler}" 2>/dev/null; then echo 'the next job did not remove a late straggler' >&2; exit 1; fi
    grep -q 'stopped 1 leftover process(es): sleep x1$' "${test_root}/_diag/runner-job-cleanup.log"
    kill -0 "${bystander}"
    # Autoscale slots leave this to their worker.
    touch "${test_root}/.autoscale-slot.json"
    : > "${test_root}/_diag/runner-job-cleanup.log"
    (cd "${test_root}" && /bin/sh -c 'echo 0 > "$0/cgroup.procs" && exec ./worker-bin/Runner.Worker' "${service_cgroup}")
    [ ! -s "${test_root}/_diag/runner-job-cleanup.log" ]
    for pid in $(cat "${test_root}/job-leftovers"); do in_cgroup "${service_cgroup}" "${pid}"; done
    kill "${bystander}"
  else
    echo 'Skipping job process containment: no writable cgroup v2 directory'
  fi
fi
echo 'Runner job temporary cleanup smoke test passed'
