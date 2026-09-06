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

case "$(basename "${BASH_SOURCE[0]}")" in
  runner-job-started.sh)
    # Also removes leftovers from a cancelled job whose completion hook never ran.
    clean_job_tmp
    if [ -n "${RUNNER_PREVIOUS_JOB_STARTED_HOOK:-}" ]; then
      run_previous_hook "${RUNNER_PREVIOUS_JOB_STARTED_HOOK}"
    fi
    ;;
  runner-job-completed.sh)
    hook_status=0
    if [ -n "${RUNNER_PREVIOUS_JOB_COMPLETED_HOOK:-}" ]; then
      run_previous_hook "${RUNNER_PREVIOUS_JOB_COMPLETED_HOOK}" || hook_status=$?
    fi
    clean_job_tmp
    exit "${hook_status}"
    ;;
  *) echo "Invoke as runner-job-started.sh or runner-job-completed.sh" >&2; exit 1 ;;
esac
