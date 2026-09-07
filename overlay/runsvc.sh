#!/bin/bash

set -euo pipefail

RUNNER_LOG_PRUNE_INTERVAL_SECONDS="${RUNNER_LOG_PRUNE_INTERVAL_SECONDS:-3600}"
RUNNER_DEFAULT_CPU_QUOTA_PERCENT="${RUNNER_DEFAULT_CPU_QUOTA_PERCENT:-}"
RUNNER_CPU_QUOTA_PATH="${RUNNER_CPU_QUOTA_PATH:-.cpu-quota}"
RUNNER_CPULIMIT_BIN="${RUNNER_CPULIMIT_BIN:-./tools/bin/cpulimit}"
PID=""
PRUNE_PID=""
CPULIMIT_PID=""
CPULIMIT_MONITOR_PID=""
MACOS_CPU_QUOTA_PERCENT=""

shutdown_children() {
  if [ -n "${CPULIMIT_MONITOR_PID}" ]; then
    kill "${CPULIMIT_MONITOR_PID}" 2>/dev/null || true
  fi

  if [ -n "${CPULIMIT_PID}" ]; then
    kill "${CPULIMIT_PID}" 2>/dev/null || true
  fi

  if [ -n "${PID}" ]; then
    kill -INT "${PID}" 2>/dev/null || true
  fi

  if [ -n "${PRUNE_PID}" ]; then
    kill "${PRUNE_PID}" 2>/dev/null || true
  fi
}

trap shutdown_children EXIT TERM INT

load_env_file() {
  local env_line

  if [ ! -f ".env" ]; then
    return 0
  fi

  while IFS= read -r env_line; do
    [ -n "${env_line}" ] || continue
    eval "export ${env_line}"
  done < .env
}

load_path_file() {
  if [ -f ".path" ]; then
    export PATH
    PATH="$(cat .path)"
  fi
}

start_log_pruner() {
  case "${RUNNER_LOG_PRUNE_INTERVAL_SECONDS}" in
    ''|*[!0-9]*)
      echo "RUNNER_LOG_PRUNE_INTERVAL_SECONDS is not a non-negative integer: ${RUNNER_LOG_PRUNE_INTERVAL_SECONDS}" >&2
      return 0
      ;;
  esac

  if [ "${RUNNER_LOG_PRUNE_INTERVAL_SECONDS}" -eq 0 ] || [ ! -x "./svc.sh" ]; then
    return 0
  fi

  ./svc.sh prune-logs >/dev/null 2>&1 || true

  (
    while true; do
      sleep "${RUNNER_LOG_PRUNE_INTERVAL_SECONDS}"
      ./svc.sh prune-logs >/dev/null 2>&1 || true
    done
  ) &
  PRUNE_PID=$!
}

read_cpu_quota_percent() {
  local cpu_quota_percent="${RUNNER_DEFAULT_CPU_QUOTA_PERCENT}"

  if [ -f "${RUNNER_CPU_QUOTA_PATH}" ]; then
    cpu_quota_percent="$(tr -d '[:space:]' < "${RUNNER_CPU_QUOTA_PATH}")"
  elif [ "$(uname -s)" = "Darwin" ]; then
    cpu_quota_percent="$(( $(sysctl -n hw.ncpu) * 50 ))"
  else
    cpu_quota_percent=200
  fi

  case "${cpu_quota_percent}" in
    ''|*[!0-9]*)
      echo "CPU quota must be a whole-number percent (received '${cpu_quota_percent}')" >&2
      exit 1
      ;;
  esac
  [ "${cpu_quota_percent}" -ge 1 ] || {
    echo "CPU quota must be at least 1%" >&2
    exit 1
  }

  if [ "$(uname -s)" = Darwin ]; then
    local maximum_percent="$(( $(sysctl -n hw.ncpu) * 100 ))"
    if [ "${cpu_quota_percent}" -gt "${maximum_percent}" ]; then cpu_quota_percent="${maximum_percent}"; fi
  fi
  printf '%s\n' "${cpu_quota_percent}"
}

process_is_active() {
  local process_state

  process_state="$(ps -o stat= -p "$1" 2>/dev/null | tr -d '[:space:]')"
  [ -n "${process_state}" ] && [[ "${process_state}" != Z* ]]
}

prepare_macos_cpu_limiter() {
  local maximum_percent

  [ "$(uname -s)" = "Darwin" ] || return 0
  [ -x "${RUNNER_CPULIMIT_BIN}" ] || {
    echo "macOS CPU limiter is missing or not executable: ${RUNNER_CPULIMIT_BIN}" >&2
    exit 1
  }

  MACOS_CPU_QUOTA_PERCENT="$(read_cpu_quota_percent)"
  maximum_percent="$(( $(sysctl -n hw.ncpu) * 100 ))"
  [ "${MACOS_CPU_QUOTA_PERCENT}" -le "${maximum_percent}" ] || {
    echo "CPU quota must not exceed ${maximum_percent}% on this Mac" >&2
    exit 1
  }
}

start_macos_cpu_limiter() {
  [ -n "${MACOS_CPU_QUOTA_PERCENT}" ] || return 0

  (
    trap 'if [ -n "${CPULIMIT_PID}" ]; then kill "${CPULIMIT_PID}" 2>/dev/null || true; wait "${CPULIMIT_PID}" 2>/dev/null || true; fi' EXIT
    trap 'exit 0' TERM INT
    while process_is_active "${PID}"; do
      next_quota="$(read_cpu_quota_percent)" || next_quota="${MACOS_CPU_QUOTA_PERCENT}"
      if [ -z "${CPULIMIT_PID}" ] || [ "${next_quota}" != "${MACOS_CPU_QUOTA_PERCENT}" ]; then
        if [ -n "${CPULIMIT_PID}" ]; then
          kill "${CPULIMIT_PID}" 2>/dev/null || true
          wait "${CPULIMIT_PID}" 2>/dev/null || true
        fi
        MACOS_CPU_QUOTA_PERCENT="${next_quota}"
        "${RUNNER_CPULIMIT_BIN}" --limit "${MACOS_CPU_QUOTA_PERCENT}" --include-children --pid "${PID}" &
        CPULIMIT_PID=$!
        sleep 0.1
      fi
      if ! process_is_active "${CPULIMIT_PID}"; then
        echo "macOS CPU limiter failed; stopping the listener" >&2
        kill -INT "${PID}" 2>/dev/null || true
        exit 1
      fi
      sleep 1
    done
  ) &
  CPULIMIT_MONITOR_PID=$!
}

ambient_started_hook="${ACTIONS_RUNNER_HOOK_JOB_STARTED:-}"
ambient_completed_hook="${ACTIONS_RUNNER_HOOK_JOB_COMPLETED:-}"
load_env_file
load_path_file

# Keep job scratch files off the host /tmp filesystem. GitHub invokes these
# hooks synchronously, so cleanup never runs in the middle of a job.
runner_root="$(pwd -P)"
export TMPDIR="${runner_root}/tmp/managed-job"
export TMP="${TMPDIR}" TEMP="${TMPDIR}"
if [ -L "${runner_root}/tmp" ] || [ -L "${TMPDIR}" ]; then
  echo "Runner temporary directory must not be a symlink" >&2
  exit 1
fi
mkdir -p "${TMPDIR}"
chmod 700 "${TMPDIR}"
if [ -n "${ambient_started_hook}" ] && [ ! "${ambient_started_hook}" -ef "${runner_root}/job-hooks/runner-job-started.sh" ]; then
  export RUNNER_PREVIOUS_JOB_STARTED_HOOK="${ambient_started_hook}"
elif [ ! "${ACTIONS_RUNNER_HOOK_JOB_STARTED:-}" -ef "${runner_root}/job-hooks/runner-job-started.sh" ]; then
  export RUNNER_PREVIOUS_JOB_STARTED_HOOK="${ACTIONS_RUNNER_HOOK_JOB_STARTED:-}"
fi
if [ -n "${ambient_completed_hook}" ] && [ ! "${ambient_completed_hook}" -ef "${runner_root}/job-hooks/runner-job-completed.sh" ]; then
  export RUNNER_PREVIOUS_JOB_COMPLETED_HOOK="${ambient_completed_hook}"
elif [ ! "${ACTIONS_RUNNER_HOOK_JOB_COMPLETED:-}" -ef "${runner_root}/job-hooks/runner-job-completed.sh" ]; then
  export RUNNER_PREVIOUS_JOB_COMPLETED_HOOK="${ACTIONS_RUNNER_HOOK_JOB_COMPLETED:-}"
fi
export ACTIONS_RUNNER_HOOK_JOB_STARTED="${runner_root}/job-hooks/runner-job-started.sh"
export ACTIONS_RUNNER_HOOK_JOB_COMPLETED="${runner_root}/job-hooks/runner-job-completed.sh"
prepare_macos_cpu_limiter
start_log_pruner

nodever="node20"

if [ -f .autoscale-slot.json ]; then
  ./externals/node24/bin/node ./bin/autoscale-worker.mjs &
else
  ./externals/${nodever}/bin/node ./bin/RunnerService.js &
fi
PID=$!
start_macos_cpu_limiter

set +e
wait "${PID}"
listener_exit_code="$?"
set -e

if [ -n "${PRUNE_PID}" ]; then
  kill "${PRUNE_PID}" 2>/dev/null || true
  wait "${PRUNE_PID}" 2>/dev/null || true
fi

if [ -n "${CPULIMIT_MONITOR_PID}" ]; then
  kill "${CPULIMIT_MONITOR_PID}" 2>/dev/null || true
  wait "${CPULIMIT_MONITOR_PID}" 2>/dev/null || true
fi

if [ -n "${CPULIMIT_PID}" ]; then
  kill "${CPULIMIT_PID}" 2>/dev/null || true
  wait "${CPULIMIT_PID}" 2>/dev/null || true
fi

trap - EXIT TERM INT
exit "${listener_exit_code}"
