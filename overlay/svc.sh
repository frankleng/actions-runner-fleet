#!/bin/bash

set -euo pipefail

RUNNER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${RUNNER_ROOT}" in
  *[!a-zA-Z0-9_./:@+-]*) echo "Unsupported service path: whitespace or shell/XML special characters" >&2; exit 1 ;;
esac
RUNNER_METADATA_PATH="${RUNNER_ROOT}/.runner"
# Slot identity survives the ephemeral runner's automatic deregistration.
if [ -f "${RUNNER_ROOT}/.autoscale-slot.json" ]; then
  RUNNER_METADATA_PATH="${RUNNER_ROOT}/.autoscale-slot.json"
fi
SVC_CMD="${1:-status}"
RUNNER_LAUNCHCTL_BIN="${RUNNER_LAUNCHCTL_BIN:-launchctl}"
RUNNER_SUDO_BIN="${RUNNER_SUDO_BIN:-sudo}"
RUNNER_INSTALL_BIN="${RUNNER_INSTALL_BIN:-/usr/bin/install}"
RUNNER_PGREP_BIN="${RUNNER_PGREP_BIN:-pgrep}"
RUNNER_PKILL_BIN="${RUNNER_PKILL_BIN:-pkill}"
RUNNER_STOP_GRACE_SECONDS="${RUNNER_STOP_GRACE_SECONDS:-2}"
RUNNER_LAUNCHD_USER="${RUNNER_LAUNCHD_USER:-${SUDO_USER:-${USER:-$(id -un)}}}"
# Test-only seam for exercising LaunchDaemon behavior in a temporary directory.
RUNNER_LAUNCHD_TEST_SKIP_ROOT="${RUNNER_LAUNCHD_TEST_SKIP_ROOT:-0}"
RUNNER_LOG_RETENTION_DAYS="${RUNNER_LOG_RETENTION_DAYS:-7}"
RUNNER_LOG_ROTATE_MAX_BYTES="${RUNNER_LOG_ROTATE_MAX_BYTES:-52428800}"
CPU_QUOTA_PATH="${RUNNER_ROOT}/.cpu-quota"
INSTALL_STARTED_SERVICE=0

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
# GitHub's runner self-update swaps bin/ for upstream files, whose service
# template uses placeholders this script does not fill and whose runsvc.sh lacks
# the kit's wrapper. Prefer the kit's own copies while the kit is on disk.
KIT_OVERLAY_DIR=""
if [ -f "${RUNNER_ROOT}/.kit-root" ]; then
  KIT_OVERLAY_DIR="$(cat "${RUNNER_ROOT}/.kit-root")/overlay"
fi

kit_or_runner_file() {
  if [ -n "${KIT_OVERLAY_DIR}" ] && [ -f "${KIT_OVERLAY_DIR}/$1" ]; then
    printf '%s\n' "${KIT_OVERLAY_DIR}/$1"
  else
    printf '%s\n' "${RUNNER_ROOT}/$2"
  fi
}

SVC_NAME="actions.runner.${RUNNER_OWNER}.${RUNNER_NAME}"
SVC_NAME="${SVC_NAME// /_}"
RUNNER_HOME="${RUNNER_ROOT}/home"
RUNNER_LOG_DIR="${RUNNER_HOME}/Library/Logs/${SVC_NAME}"
LAUNCHD_USER_HOME="${RUNNER_LAUNCHD_USER_HOME:-$(default_launchd_user_home)}"
LAUNCH_PATH="${RUNNER_LAUNCH_PATH:-/Library/LaunchDaemons}"
PLIST_PATH="${LAUNCH_PATH}/${SVC_NAME}.plist"
LAUNCHD_DOMAIN="system"
LAUNCHD_SERVICE_TARGET="${LAUNCHD_DOMAIN}/${SVC_NAME}"
LEGACY_LAUNCH_PATH="${RUNNER_LEGACY_LAUNCH_PATH:-${LAUNCHD_USER_HOME}/Library/LaunchAgents}"
LEGACY_PLIST_PATH="${LEGACY_LAUNCH_PATH}/${SVC_NAME}.plist"
LEGACY_SERVICE_TARGET="gui/$(id -u "${RUNNER_LAUNCHD_USER}")/${SVC_NAME}"
TEMPLATE_PATH="$(kit_or_runner_file bin/actions.runner.plist.template bin/actions.runner.plist.template)"
RUNSVC_SOURCE_PATH="$(kit_or_runner_file runsvc.sh bin/runsvc.sh)"
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

run_privileged() {
  if [ "${RUNNER_LAUNCHD_TEST_SKIP_ROOT}" = "1" ] || [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    "${RUNNER_SUDO_BIN}" "$@"
  fi
}

run_privileged_launchctl() {
  run_privileged "${RUNNER_LAUNCHCTL_BIN}" "$@"
}

service_is_loaded() {
  run_privileged_launchctl print "$1" >/dev/null 2>&1
}

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

  if [ "${value}" -gt "${MAX_CPU_QUOTA_PERCENT}" ] 2>/dev/null; then
    echo "Saved CPU quota exceeds current CPU capacity; using the host ceiling" >&2
    value="${MAX_CPU_QUOTA_PERCENT}"
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
  local -a plist_install_args

  if [ ! -f "${TEMPLATE_PATH}" ]; then
    failed "service template not found at ${TEMPLATE_PATH}"
  fi

  local value
  for value in "${PLIST_PATH}" "${SVC_NAME}" "${RUNNER_LAUNCHD_USER}" "${RUNNER_ROOT}" "${HOME}" "${TMPDIR}" "${RUNNER_TEMP}" "${RUNNER_TOOL_CACHE}" "${PNPM_HOME}" "${COREPACK_HOME}" "${PULUMI_HOME}" "${PATH}"; do
    case "${value}" in *[!a-zA-Z0-9_./:@+-]*) failed "Unsupported runtime path for service template" ;; esac
  done
  mkdir -p "${RUNNER_LOG_DIR}"
  if [ "${RUNNER_LAUNCHD_TEST_SKIP_ROOT}" = "1" ]; then
    mkdir -p "${LAUNCH_PATH}"
  fi

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
    "${TEMPLATE_PATH}" > "${TEMP_PATH}" || {
      rm -f "${TEMP_PATH}"
      failed "failed to render plist"
    }
  if grep -q '{{' "${TEMP_PATH}"; then
    rm -f "${TEMP_PATH}"
    failed "service template ${TEMPLATE_PATH} left unrendered placeholders; run ./manage-runners.sh reconcile ${RUNNER_NAME}"
  fi

  plutil -lint "${TEMP_PATH}" >/dev/null || {
    rm -f "${TEMP_PATH}"
    failed "rendered launchd plist is invalid"
  }
  if [ "${RUNNER_LAUNCHD_TEST_SKIP_ROOT}" = "1" ]; then
    plist_install_args=(-m 0644 "${TEMP_PATH}" "${PLIST_PATH}")
  else
    plist_install_args=(-o root -g wheel -m 0644 "${TEMP_PATH}" "${PLIST_PATH}")
  fi
  if ! run_privileged "${RUNNER_INSTALL_BIN}" "${plist_install_args[@]}"; then
    rm -f "${TEMP_PATH}"
    failed "failed to install ${PLIST_PATH}; macOS administrator access is required"
  fi
  rm -f "${TEMP_PATH}"
}

sync_runtime_files() {
  load_runtime_environment
  render_plist
  # Replace by rename: a running listener's bash reads runsvc.sh incrementally.
  cp "${RUNSVC_SOURCE_PATH}" "${RUNNER_ROOT}/runsvc.sh.tmp" || failed "failed to copy runsvc.sh"
  chmod u+x "${RUNNER_ROOT}/runsvc.sh.tmp" || failed "failed to chmod runsvc.sh"
  mv "${RUNNER_ROOT}/runsvc.sh.tmp" "${RUNNER_ROOT}/runsvc.sh" || failed "failed to install runsvc.sh"
  printf '%s\n' "${PLIST_PATH}" > "${CONFIG_PATH}" || failed "failed to write ${CONFIG_PATH}"
}

install() {
  local migrated_legacy_agent=0

  persist_cpu_quota_percent "$(read_cpu_quota_percent)"
  sync_runtime_files

  if [ "${LEGACY_PLIST_PATH}" != "${PLIST_PATH}" ] && [ -f "${LEGACY_PLIST_PATH}" ]; then
    migrated_legacy_agent=1
    if service_is_loaded "${LEGACY_SERVICE_TARGET}"; then
      run_privileged_launchctl bootout "${LEGACY_SERVICE_TARGET}" 2>/dev/null ||
        run_privileged_launchctl unload "${LEGACY_PLIST_PATH}" 2>/dev/null || true
    fi
    rm -f "${LEGACY_PLIST_PATH}" || failed "failed to remove legacy LaunchAgent ${LEGACY_PLIST_PATH}"
    echo "migrated legacy LaunchAgent to system LaunchDaemon"
  fi

  if [ "${migrated_legacy_agent}" -eq 1 ]; then
    start_launch_daemon
    INSTALL_STARTED_SERVICE=1
  fi
  echo "svc install complete"
}

status() {
  local service_pid
  local status_out

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

  status_out="$("${RUNNER_LAUNCHCTL_BIN}" print "${LAUNCHD_SERVICE_TARGET}" 2>/dev/null || true)"
  service_pid="$(printf '%s\n' "${status_out}" | awk '$1 == "pid" && $2 == "=" { print $3; exit }')"
  if [ -n "${service_pid}" ]; then
    echo "Started:"
    echo "${service_pid} 0 ${SVC_NAME}"
    echo
  elif "${RUNNER_LAUNCHCTL_BIN}" print-disabled "${LAUNCHD_DOMAIN}" 2>/dev/null |
    grep -Fq "\"${SVC_NAME}\" => disabled"; then
    echo "Disabled"
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
  echo "CPU limit for ${RUNNER_NAME}: ${cpu_quota_percent}% (running wrappers reload within one second)"
}

start_launch_daemon() {
  run_privileged_launchctl enable "${LAUNCHD_SERVICE_TARGET}" ||
    failed "failed to enable ${LAUNCHD_SERVICE_TARGET}"

  if service_is_loaded "${LAUNCHD_SERVICE_TARGET}"; then
    # No -k: never kill an already running listener.
    run_privileged_launchctl kickstart "${LAUNCHD_SERVICE_TARGET}" ||
      failed "failed to start ${LAUNCHD_SERVICE_TARGET}"
  else
    run_privileged_launchctl bootstrap "${LAUNCHD_DOMAIN}" "${PLIST_PATH}" ||
      failed "failed to bootstrap ${PLIST_PATH}"
  fi
}

start() {
  if [ ! -f "${PLIST_PATH}" ]; then
    install
  fi

  echo "starting ${SVC_NAME}"
  if [ "${INSTALL_STARTED_SERVICE}" -ne 1 ]; then
    start_launch_daemon
  fi
  status
}

stop() {
  if [ ! -f "${PLIST_PATH}" ]; then
    echo "stopping ${SVC_NAME}"
    echo "service is not installed"
    return 0
  fi

  echo "stopping ${SVC_NAME}"
  if service_is_loaded "${LAUNCHD_SERVICE_TARGET}"; then
    run_privileged_launchctl bootout "${LAUNCHD_SERVICE_TARGET}" ||
      failed "failed to boot out ${LAUNCHD_SERVICE_TARGET}"
  fi
  status
}

uninstall() {
  stop
  run_privileged rm -f "${PLIST_PATH}" || failed "failed to remove ${PLIST_PATH}"
  rm -f "${CONFIG_PATH}"
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
