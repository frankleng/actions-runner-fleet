#!/bin/bash

set -euo pipefail

RUNNER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_METADATA_PATH="${RUNNER_ROOT}/.runner"
SVC_CMD="${1:-status}"
RUNNER_LAUNCHCTL_BIN="${RUNNER_LAUNCHCTL_BIN:-launchctl}"
RUNNER_PGREP_BIN="${RUNNER_PGREP_BIN:-pgrep}"
RUNNER_PKILL_BIN="${RUNNER_PKILL_BIN:-pkill}"
RUNNER_STOP_GRACE_SECONDS="${RUNNER_STOP_GRACE_SECONDS:-2}"
RUNNER_LAUNCHD_USER="${RUNNER_LAUNCHD_USER:-${USER:-$(id -un)}}"
RUNNER_LOG_RETENTION_DAYS="${RUNNER_LOG_RETENTION_DAYS:-7}"
RUNNER_LOG_ROTATE_MAX_BYTES="${RUNNER_LOG_ROTATE_MAX_BYTES:-52428800}"
CPU_QUOTA_PATH="${RUNNER_ROOT}/.cpu-quota"

read_runner_json_value() {
  local key="$1"

  awk -F '"' -v field_name="${key}" '
    NR == 1 { sub(/^\xef\xbb\xbf/, "") }
    { for (i = 2; i <= NF; i += 2) if ($i == field_name) { print $(i + 2); exit } }
  ' "${RUNNER_METADATA_PATH}"
}

default_launchd_user_home() {
  if [ -n "${HOME:-}" ] && [ -d "${HOME}" ] && [ "${HOME}" != "${RUNNER_ROOT}/home" ]; then
    printf '%s\n' "${HOME}"
    return 0
  fi

  eval "printf '%s\n' ~${RUNNER_LAUNCHD_USER}"
}

require_runner_metadata() {
  if [ ! -f "${RUNNER_METADATA_PATH}" ]; then
    echo "runner metadata missing: ${RUNNER_METADATA_PATH}" >&2
    exit 1
  fi
}

require_runner_metadata

RUNNER_NAME="$(read_runner_json_value "agentName")"
GITHUB_URL="$(read_runner_json_value "gitHubUrl")"
RUNNER_OWNER="${GITHUB_URL%/}"
RUNNER_OWNER="${RUNNER_OWNER##*/}"
SVC_NAME="actions.runner.${RUNNER_OWNER}.${RUNNER_NAME}"
SVC_NAME="${SVC_NAME// /_}"
RUNNER_HOME="${RUNNER_ROOT}/home"
RUNNER_LOG_DIR="${RUNNER_HOME}/Library/Logs/${SVC_NAME}"
LAUNCHD_USER_HOME="${RUNNER_LAUNCHD_USER_HOME:-$(default_launchd_user_home)}"
LAUNCH_PATH="${RUNNER_LAUNCH_PATH:-${LAUNCHD_USER_HOME}/Library/LaunchAgents}"
PLIST_PATH="${LAUNCH_PATH}/${SVC_NAME}.plist"
TEMPLATE_PATH="${RUNNER_ROOT}/bin/actions.runner.plist.template"
TEMP_PATH="${RUNNER_ROOT}/bin/actions.runner.plist.temp"
CONFIG_PATH="${RUNNER_ROOT}/.service"
RUNTIME_PATH_FILE="${RUNNER_ROOT}/.path"
RUNTIME_ENV_FILE="${RUNNER_ROOT}/.env"

failed() {
  local error="${1:-Undefined error}"
  echo "Failed: ${error}" >&2
  exit 1
}

detect_available_cpu_count() {
  local cpu_count=""

  cpu_count="$(sysctl -n hw.ncpu 2>/dev/null || true)"
  cpu_count="${cpu_count//[[:space:]]/}"
  case "${cpu_count}" in
    ''|*[!0-9]*|0) cpu_count="" ;;
  esac

  if [ -z "${cpu_count}" ]; then
    cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)"
    cpu_count="${cpu_count//[[:space:]]/}"
  fi
  case "${cpu_count}" in
    ''|*[!0-9]*|0) cpu_count="" ;;
  esac

  if [ -z "${cpu_count}" ]; then
    cpu_count="$(nproc 2>/dev/null || true)"
    cpu_count="${cpu_count//[[:space:]]/}"
  fi
  case "${cpu_count}" in
    ''|*[!0-9]*|0) failed "could not determine the number of available logical CPUs" ;;
  esac

  printf '%s\n' "${cpu_count}"
}

AVAILABLE_CPU_COUNT="$(detect_available_cpu_count)"
MAX_CPU_QUOTA_PERCENT="$((AVAILABLE_CPU_COUNT * 100))"
CALCULATED_DEFAULT_CPU_QUOTA_PERCENT="$((MAX_CPU_QUOTA_PERCENT * 50 / 100))"
DEFAULT_CPU_QUOTA_PERCENT="${RUNNER_DEFAULT_CPU_QUOTA_PERCENT:-${CALCULATED_DEFAULT_CPU_QUOTA_PERCENT}}"

require_non_negative_integer() {
  local value_name="$1"
  local value="$2"

  case "${value}" in
    ''|*[!0-9]*)
      failed "${value_name} must be a non-negative integer (received '${value}')"
      ;;
  esac
}

validate_cpu_quota_percent() {
  local value="$1"

  require_non_negative_integer "CPU quota" "${value}"
  [ "${value}" -ge 1 ] || failed "CPU quota must be at least 1%"
  [ "${value}" -le "${MAX_CPU_QUOTA_PERCENT}" ] ||
    failed "CPU quota must not exceed ${MAX_CPU_QUOTA_PERCENT}% on this Mac"
}

read_cpu_quota_percent() {
  local value="${DEFAULT_CPU_QUOTA_PERCENT}"

  if [ -f "${CPU_QUOTA_PATH}" ]; then
    value="$(tr -d '[:space:]' < "${CPU_QUOTA_PATH}")"
  fi

  validate_cpu_quota_percent "${value}"
  printf '%s\n' "${value}"
}

persist_cpu_quota_percent() {
  local value="$1"

  validate_cpu_quota_percent "${value}"
  printf '%s\n' "${value}" > "${CPU_QUOTA_PATH}.tmp"
  mv "${CPU_QUOTA_PATH}.tmp" "${CPU_QUOTA_PATH}"
}

log_file_size_bytes() {
  local log_path="$1"
  wc -c < "${log_path}" | tr -d '[:space:]'
}

rotate_log_if_needed() {
  local log_path="$1"
  local log_size
  local rotated_path
  local timestamp

  [ -f "${log_path}" ] || return 0
  [ "${RUNNER_LOG_ROTATE_MAX_BYTES}" -gt 0 ] || return 0

  log_size="$(log_file_size_bytes "${log_path}")"
  if [ "${log_size}" -lt "${RUNNER_LOG_ROTATE_MAX_BYTES}" ]; then
    return 0
  fi

  timestamp="$(date -u +%Y%m%d-%H%M%S)"
  rotated_path="${log_path}.${timestamp}"
  cp "${log_path}" "${rotated_path}" || failed "failed to rotate ${log_path}"
  : > "${log_path}" || failed "failed to truncate ${log_path}"
}

prune_old_logs() {
  local diag_dir="${RUNNER_ROOT}/_diag"

  require_non_negative_integer "RUNNER_LOG_RETENTION_DAYS" "${RUNNER_LOG_RETENTION_DAYS}"
  require_non_negative_integer "RUNNER_LOG_ROTATE_MAX_BYTES" "${RUNNER_LOG_ROTATE_MAX_BYTES}"

  mkdir -p "${RUNNER_LOG_DIR}"

  rotate_log_if_needed "${RUNNER_LOG_DIR}/stdout.log"
  rotate_log_if_needed "${RUNNER_LOG_DIR}/stderr.log"

  find "${RUNNER_LOG_DIR}" -type f \
    \( -name 'stdout.log.*' -o -name 'stderr.log.*' \) \
    -mtime "+${RUNNER_LOG_RETENTION_DAYS}" -delete 2>/dev/null || true

  if [ -d "${diag_dir}" ]; then
    find "${diag_dir}" -type f \
      \( -name 'Runner_*.log' -o -name 'Worker_*.log' -o -path '*/blocks/*' -o -path '*/pages/*' \) \
      -mtime "+${RUNNER_LOG_RETENTION_DAYS}" -delete 2>/dev/null || true
  fi
}

load_runtime_environment() {
  local env_line

  if [ ! -f "${RUNTIME_ENV_FILE}" ] || [ ! -f "${RUNTIME_PATH_FILE}" ]; then
    (
      cd "${RUNNER_ROOT}"
      ./env.sh
    )
  fi

  while IFS= read -r env_line; do
    [ -n "${env_line}" ] || continue
    eval "export ${env_line}"
  done < "${RUNTIME_ENV_FILE}"

  export PATH
  PATH="$(cat "${RUNTIME_PATH_FILE}")"
}

render_plist() {
  if [ ! -f "${TEMPLATE_PATH}" ]; then
    failed "service template not found at ${TEMPLATE_PATH}"
  fi

  mkdir -p "${LAUNCH_PATH}" "${RUNNER_LOG_DIR}"

  sed \
    -e "s#{{SvcName}}#${SVC_NAME}#g" \
    -e "s#{{User}}#${RUNNER_LAUNCHD_USER}#g" \
    -e "s#{{RunnerRoot}}#${RUNNER_ROOT}#g" \
    -e "s#{{RuntimeHome}}#${HOME}#g" \
    -e "s#{{RuntimeTmp}}#${TMPDIR}#g" \
    -e "s#{{RunnerTemp}}#${RUNNER_TEMP}#g" \
    -e "s#{{RunnerToolCache}}#${RUNNER_TOOL_CACHE}#g" \
    -e "s#{{PnpmHome}}#${PNPM_HOME}#g" \
    -e "s#{{CorepackHome}}#${COREPACK_HOME}#g" \
    -e "s#{{PulumiHome}}#${PULUMI_HOME}#g" \
    -e "s#{{RuntimePath}}#${PATH}#g" \
    -e "s#{{StdoutPath}}#${RUNNER_LOG_DIR}/stdout.log#g" \
    -e "s#{{StderrPath}}#${RUNNER_LOG_DIR}/stderr.log#g" \
    "${TEMPLATE_PATH}" > "${TEMP_PATH}" || failed "failed to render plist"
  mv "${TEMP_PATH}" "${PLIST_PATH}" || failed "failed to write plist"
}

sync_runtime_files() {
  load_runtime_environment
  render_plist
  cp "${RUNNER_ROOT}/bin/runsvc.sh" "${RUNNER_ROOT}/runsvc.sh" || failed "failed to copy runsvc.sh"
  chmod u+x "${RUNNER_ROOT}/runsvc.sh" || failed "failed to chmod runsvc.sh"
  printf '%s\n' "${PLIST_PATH}" > "${CONFIG_PATH}" || failed "failed to write ${CONFIG_PATH}"
}

install() {
  persist_cpu_quota_percent "$(read_cpu_quota_percent)"
  sync_runtime_files
  echo "svc install complete"
}

status() {
  echo "status ${SVC_NAME}:"
  echo
  echo "CPU limit: $(read_cpu_quota_percent)%"
  if [ ! -f "${PLIST_PATH}" ]; then
    echo
    echo "not installed"
    echo
    return 0
  fi

  echo
  echo "${PLIST_PATH}"
  echo

  status_out="$(
    "${RUNNER_LAUNCHCTL_BIN}" list 2>/dev/null |
      awk -v service_name="${SVC_NAME}" '$3 == service_name { print }' ||
      true
  )"
  if [ -n "${status_out}" ]; then
    echo "Started:"
    echo "${status_out}"
    echo
  else
    echo "Stopped"
    echo
  fi
}

set_cpu_limit() {
  local cpu_quota_percent="${1:-}"

  validate_cpu_quota_percent "${cpu_quota_percent}"
  persist_cpu_quota_percent "${cpu_quota_percent}"
  echo "CPU limit for ${RUNNER_NAME}: ${cpu_quota_percent}% (applies after the next service restart)"
}

start() {
  if [ ! -f "${PLIST_PATH}" ]; then
    install
  fi

  echo "starting ${SVC_NAME}"
  "${RUNNER_LAUNCHCTL_BIN}" load -w "${PLIST_PATH}" || failed "failed to load ${PLIST_PATH}"
  status
}

stop() {
  if [ ! -f "${PLIST_PATH}" ]; then
    echo "stopping ${SVC_NAME}"
    echo "service is not installed"
    return 0
  fi

  echo "stopping ${SVC_NAME}"
  "${RUNNER_LAUNCHCTL_BIN}" unload "${PLIST_PATH}" || failed "failed to unload ${PLIST_PATH}"
  status
}

uninstall() {
  stop
  rm -f "${PLIST_PATH}" "${CONFIG_PATH}"
}

usage() {
  cat <<EOF
Usage:
./svc.sh [install, start, stop, status, set-cpu-limit <percent>, uninstall, prune-logs]
EOF
}

runner_path_regex() {
  printf '%s' "$1" | sed -e 's/[][(){}.^$*+?|\\]/\\&/g'
}

runner_process_pids() {
  local escaped_runner_root

  escaped_runner_root="$(runner_path_regex "${RUNNER_ROOT}")"

  {
    "${RUNNER_PGREP_BIN}" -f "${escaped_runner_root}/runsvc\\.sh" 2>/dev/null || true
    "${RUNNER_PGREP_BIN}" -f "${escaped_runner_root}/bin/Runner\\.Listener" 2>/dev/null || true
    "${RUNNER_PGREP_BIN}" -f "${escaped_runner_root}/bin\\.[^/]+/Runner\\.Worker" 2>/dev/null || true
  } | awk 'NF > 0 { print $1 }' | sort -u
}

kill_runner_processes() {
  local signal="$1"
  local escaped_runner_root

  escaped_runner_root="$(runner_path_regex "${RUNNER_ROOT}")"

  "${RUNNER_PKILL_BIN}" -"${signal}" -f "${escaped_runner_root}/runsvc\\.sh" 2>/dev/null || true
  "${RUNNER_PKILL_BIN}" -"${signal}" -f "${escaped_runner_root}/bin/Runner\\.Listener" 2>/dev/null || true
  "${RUNNER_PKILL_BIN}" -"${signal}" -f "${escaped_runner_root}/bin\\.[^/]+/Runner\\.Worker" 2>/dev/null || true
}

ensure_runner_stopped() {
  local pids

  pids="$(runner_process_pids)"
  if [ -z "${pids}" ]; then
    return 0
  fi

  echo "detected lingering runner processes in ${RUNNER_ROOT}; sending SIGTERM"
  kill_runner_processes TERM
  sleep "${RUNNER_STOP_GRACE_SECONDS}"

  pids="$(runner_process_pids)"
  if [ -z "${pids}" ]; then
    echo "runner processes terminated for ${RUNNER_ROOT}"
    return 0
  fi

  echo "runner processes still alive in ${RUNNER_ROOT}; sending SIGKILL"
  kill_runner_processes KILL
  sleep 1

  pids="$(runner_process_pids)"
  if [ -n "${pids}" ]; then
    failed "failed to stop all runner processes in ${RUNNER_ROOT}; remaining PIDs: ${pids//$'\n'/ }"
  fi

  echo "runner processes terminated for ${RUNNER_ROOT}"
}

case "${SVC_CMD}" in
  install)
    install
    ;;
  start)
    start
    ;;
  stop)
    stop
    ensure_runner_stopped
    ;;
  status)
    status
    ;;
  set-cpu-limit)
    set_cpu_limit "${2:-}"
    ;;
  uninstall)
    uninstall
    ;;
  prune-logs)
    prune_old_logs
    ;;
  *)
    usage
    exit 1
    ;;
esac
