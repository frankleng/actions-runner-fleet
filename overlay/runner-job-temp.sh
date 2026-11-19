#!/bin/bash
set -euo pipefail

# Kept outside bin, which the runner replaces during automatic upgrades.
runner_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
job_tmp="${runner_root}/tmp/managed-job"

run_previous_hook() {
  # Path aliases must never turn the wrapper into its own previous hook.
  [ "$1" -ef "${BASH_SOURCE[0]}" ] && return 0
  case "$1" in
    *.ps1)
      if command -v pwsh >/dev/null 2>&1; then
        pwsh -NoLogo -NoProfile -NonInteractive -File "$1"
      elif command -v powershell >/dev/null 2>&1; then
        powershell -NoLogo -NoProfile -NonInteractive -File "$1"
      else
        echo "Cannot run previous PowerShell hook: pwsh or powershell is required" >&2
        return 1
      fi
      ;;
    *) /bin/bash -e "$1" ;;
  esac
}

clean_job_tmp() {
  # Never traverse a redirected temporary root or a nested filesystem.
  if [ -L "${runner_root}/tmp" ] || [ -L "${job_tmp}" ]; then
    echo "Refusing to clean a symlinked runner temporary directory" >&2
    return 1
  fi
  mkdir -p "${job_tmp}"
  chmod 700 "${job_tmp}"
  # A mounted directory itself can produce EBUSY despite -xdev. Report
  # leftovers without failing every subsequent job on this runner.
  if ! find "${job_tmp}" -xdev -depth -mindepth 1 -delete; then
    echo "Warning: some runner scratch files could not be removed; check mounts and permissions in ${job_tmp}" >&2
  fi
}

# Jobs leave processes behind (dev servers, build daemons) that setsid or
# double-fork away from the runner, which reparents them to the user manager.
# The runner kills only the tracked processes in one snapshot, so a process
# forked after it survives until the service restarts. Autoscale slots run each
# listener generation in a child cgroup and empty it themselves
# (autoscale-worker.mjs). A persistent runner keeps its listener across jobs,
# so these hooks move each job's Runner.Worker into the service's runner-job
# child cgroup, where every process the job starts lands, and empty it. Linux
# with cgroup v2 only; containment problems never fail a job.
cleanup_log() {
  local log="${runner_root}/_diag/runner-job-cleanup.log"

  echo "Job process cleanup: $*" >&2
  [ -d "${runner_root}/_diag" ] && [ ! -L "${log}" ] || return 0
  if [ -f "${log}" ] && [ "$(wc -c < "${log}")" -gt 1048576 ]; then mv -f "${log}" "${log}.1"; fi
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "${log}" 2>/dev/null || true
}

# Prints the service cgroup and its runner-job child. The hook runs in one or
# the other; anything but a systemd service cgroup is left alone.
job_cgroup_paths() {
  local own service

  [ "$(uname -s)" = Linux ] && [ ! -f "${runner_root}/.autoscale-slot.json" ] || return 1
  own="$(sed -n 's/^0:://p' /proc/self/cgroup 2>/dev/null)"
  service="${own%/runner-job}"
  case "${service}" in /*.service) ;; *) return 1 ;; esac
  [ -w "/sys/fs/cgroup${service}/cgroup.procs" ] || return 1
  mkdir -p "/sys/fs/cgroup${service}/runner-job" 2>/dev/null || return 1
  printf '%s\n%s\n' "/sys/fs/cgroup${service}" "/sys/fs/cgroup${service}/runner-job"
}

# The Runner.Worker this hook belongs to: the nearest such ancestor.
job_worker_pid() {
  local pid="${PPID}" depth

  for depth in 1 2 3 4 5 6; do
    [ "${pid}" -gt 1 ] 2>/dev/null || return 1
    if [ "$(cat "/proc/${pid}/comm" 2>/dev/null)" = Runner.Worker ]; then
      printf '%s\n' "${pid}"
      return 0
    fi
    pid="$(awk '/^PPid:/ { print $2 }' "/proc/${pid}/status" 2>/dev/null)" || return 1
  done
  return 1
}

# Processes in the job cgroup except the one to keep. Each PID is rechecked
# against the cgroup right before it is signalled.
job_cgroup_others() {
  local pid

  while read -r pid; do
    [ -n "${pid}" ] && [ "${pid}" != "$2" ] && printf '%s\n' "${pid}"
  done 2>/dev/null < "$1/cgroup.procs"
}

signal_in_cgroup() {
  local signal="$1" cgroup="$2" pid="$3"

  grep -qxF "0::${cgroup#/sys/fs/cgroup}" "/proc/${pid}/cgroup" 2>/dev/null && kill "-${signal}" "${pid}" 2>/dev/null || true
}

# Stops everything in the job cgroup but the PID to keep: SIGTERM, a short
# grace period, then SIGKILL. Logs process names and counts only, never
# arguments or environments, which can hold secrets.
empty_job_cgroup() {
  local cgroup="$1" keep="${2:-}" pid pids name summary="" count=0 killed=0 remaining tick round

  pids="$(job_cgroup_others "${cgroup}" "${keep}")"
  if [ -z "${pids}" ] && ! { [ -z "${keep}" ] && grep -qx 'populated 1' "${cgroup}/cgroup.events" 2>/dev/null; }; then
    # Started hooks stay quiet when there is nothing to do.
    [ -z "${keep}" ] || cleanup_log "no leftover processes"
    return 0
  fi
  for pid in ${pids}; do
    name="$(cat "/proc/${pid}/comm" 2>/dev/null || echo '?')"
    summary="${summary}${name}"$'\n'
    count=$((count + 1))
    signal_in_cgroup TERM "${cgroup}" "${pid}"
  done
  for tick in $(seq 50); do
    [ -n "$(job_cgroup_others "${cgroup}" "${keep}")" ] || break
    sleep 0.1
  done
  if [ -z "${keep}" ] && [ -e "${cgroup}/cgroup.kill" ]; then
    if [ -n "$(job_cgroup_others "${cgroup}" "")" ] || grep -qx 'populated 1' "${cgroup}/cgroup.events" 2>/dev/null; then
      killed="$(job_cgroup_others "${cgroup}" "" | wc -l)"
      echo 1 > "${cgroup}/cgroup.kill" 2>/dev/null || true
    fi
  else
    # The worker stays, so kill one by one; repeat for processes forked meanwhile.
    for round in 1 2 3; do
      pids="$(job_cgroup_others "${cgroup}" "${keep}")"
      [ -n "${pids}" ] || break
      killed=$((killed + $(printf '%s\n' "${pids}" | wc -l)))
      for pid in ${pids}; do signal_in_cgroup KILL "${cgroup}" "${pid}"; done
      sleep 0.2
    done
  fi
  for tick in $(seq 50); do
    [ -n "$(job_cgroup_others "${cgroup}" "${keep}")" ] || break
    sleep 0.1
  done
  remaining="$(job_cgroup_others "${cgroup}" "${keep}" | wc -l)"
  summary="$(printf '%s' "${summary}" | sort | uniq -c | awk '{ n = $1; sub(/^ *[0-9]+ /, ""); printf "%s%s x%s", (NR > 1 ? ", " : ""), $0, n }')"
  cleanup_log "stopped ${count} leftover process(es)${summary:+: ${summary}}$( [ "${killed}" -eq 0 ] || printf '; %s needed SIGKILL' "${killed}")$( [ "${remaining}" -eq 0 ] || printf '; %s could not be stopped' "${remaining}")"
}

contain_job_processes() {
  local paths service cgroup worker

  paths="$(job_cgroup_paths)" || return 0
  service="${paths%%$'\n'*}"
  cgroup="${paths#*$'\n'}"
  worker="$(job_worker_pid)" || { cleanup_log "no Runner.Worker ancestor; skipped"; return 0; }
  # Keep this hook and its helpers out of the cgroup it empties.
  echo "$$" > "${service}/cgroup.procs" 2>/dev/null || return 0
  case "$1" in
    started)
      # The previous job's worker has exited; whatever it left behind goes now.
      # If one still runs, leave everything for the next job.
      if grep -qxF Runner.Worker < <(while read -r pid; do cat "/proc/${pid}/comm" 2>/dev/null; done 2>/dev/null < "${cgroup}/cgroup.procs"); then
        cleanup_log "a previous Runner.Worker is still running; skipped"
      else
        empty_job_cgroup "${cgroup}" ""
      fi
      echo "${worker}" > "${cgroup}/cgroup.procs" 2>/dev/null || cleanup_log "could not contain this job's processes"
      ;;
    completed)
      # The worker still finishes the job. Anything forked after this is
      # removed when the next job starts.
      grep -qxF "${worker}" "${cgroup}/cgroup.procs" 2>/dev/null || return 0
      empty_job_cgroup "${cgroup}" "${worker}"
      ;;
  esac
}

case "$(basename "${BASH_SOURCE[0]}")" in
  runner-job-started.sh)
    # Also removes leftovers from a cancelled job whose completion hook never ran.
    clean_job_tmp
    contain_job_processes started || true
    if [ -n "${RUNNER_PREVIOUS_JOB_STARTED_HOOK:-}" ]; then
      run_previous_hook "${RUNNER_PREVIOUS_JOB_STARTED_HOOK}"
    fi
    ;;
  runner-job-completed.sh)
    hook_status=0
    if [ -n "${RUNNER_PREVIOUS_JOB_COMPLETED_HOOK:-}" ]; then
      run_previous_hook "${RUNNER_PREVIOUS_JOB_COMPLETED_HOOK}" || hook_status=$?
    fi
    contain_job_processes completed || true
    clean_job_tmp
    exit "${hook_status}"
    ;;
  *) echo "Invoke as runner-job-started.sh or runner-job-completed.sh" >&2; exit 1 ;;
esac
