#!/bin/bash
# Root-owned helper that performs only the launchd operations svc.sh needs for
# runner LaunchDaemons. install-launchd-helper.sh copies it to a root-owned path
# and lets the setup account run it through sudo without a password, so every
# argument is untrusted: anything outside the runner-only forms below is refused.
#
#   launchd-helper launchctl print|enable|kickstart|bootout system/<label>
#   launchd-helper launchctl bootstrap system /Library/LaunchDaemons/<label>.plist
#   launchd-helper launchctl print|bootout gui/<caller uid>/<label>
#   launchd-helper install -o root -g wheel -m 0644 <rendered plist> /Library/LaunchDaemons/<label>.plist
#   launchd-helper rm -f /Library/LaunchDaemons/<label>.plist
#   launchd-helper validate <plist>   (checks a plist without changing anything)
#   launchd-helper check              (lets callers confirm passwordless access)

set -euo pipefail

# sudo keeps HOME and other caller variables; tools such as jq would read
# caller-owned files through them (~/.jq), so rerun with only what is needed.
if [ "${LAUNCHD_HELPER_CLEAN_ENV:-}" != "1" ]; then
  exec /usr/bin/env -i LAUNCHD_HELPER_CLEAN_ENV=1 PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/var/empty \
    SUDO_USER="${SUDO_USER:-}" SUDO_UID="${SUDO_UID:-}" /bin/bash "$0" "$@"
fi
umask 022

LAUNCH_DAEMONS_DIR=/Library/LaunchDaemons
LABEL_PATTERN='^actions\.runner\.[A-Za-z0-9_.@+-]+$'

fail() {
  echo "launchd-helper: $*" >&2
  exit 1
}

caller_user="${SUDO_USER:-}"
caller_uid="${SUDO_UID:-}"

require_caller() {
  [ -n "${caller_user}" ] && [ -n "${caller_uid}" ] || fail "must be run through sudo"
  [ "${caller_user}" != "root" ] && [ "${caller_uid}" != "0" ] || fail "refusing to manage services for root"
}

require_label() {
  [[ "$1" =~ ${LABEL_PATTERN} ]] || fail "not a runner service label: $1"
}

daemon_path() {
  printf '%s/%s.plist\n' "${LAUNCH_DAEMONS_DIR}" "$1"
}

# A plist may run only the caller's own runsvc.sh, as the caller, with the
# keys the service template renders. That keeps every daemon at the caller's
# privilege level no matter what the caller hands this helper.
validate_plist() {
  local plist="$1"
  local user="$2"

  plutil -lint -s "${plist}" >/dev/null 2>&1 || fail "invalid plist"
  plutil -convert json -o - "${plist}" 2>/dev/null | jq -e -r --arg user "${user}" --arg label_pattern "${LABEL_PATTERN}" '
    select(
      type == "object"
      and ((keys - ["Label", "ProgramArguments", "UserName", "WorkingDirectory", "KeepAlive",
                    "ThrottleInterval", "RunAtLoad", "StandardOutPath", "StandardErrorPath",
                    "EnvironmentVariables", "SessionCreate"]) == [])
      and (.Label | type == "string" and test($label_pattern))
      and .UserName == $user
      and (.WorkingDirectory | type == "string" and test("^/[A-Za-z0-9_./:@+-]+$")
           and (test("/\\.\\.?(/|$)") | not))
      and .ProgramArguments == [.WorkingDirectory + "/runsvc.sh"]
      and ((.EnvironmentVariables // {}) | type == "object" and all(.[]; type == "string"))
    ) | .Label
  ' 2>/dev/null || fail "plist is not a runner service for ${user}"
}

# Existing daemons must also belong to the caller before they are changed.
require_owned_daemon() {
  local label="$1"
  local path

  path="$(daemon_path "${label}")"
  [ -f "${path}" ] && [ ! -L "${path}" ] || fail "no runner daemon at ${path}"
  [ "$(stat -f '%u' "${path}")" = "0" ] || fail "${path} is not owned by root"
  [ "$(validate_plist "${path}" "${caller_user}")" = "${label}" ] || fail "${path} label mismatch"
}

run_launchctl() {
  local verb="${1:-}"
  local target="${2:-}"
  local label

  case "${verb}:$#" in
    print:2)
      case "${target}" in
        system/*) label="${target#system/}"; target="system" ;;
        "gui/${caller_uid}/"*) label="${target#gui/${caller_uid}/}"; target="gui/${caller_uid}" ;;
        *) fail "unsupported launchctl target: ${target}" ;;
      esac
      require_label "${label}"
      exec launchctl print "${target}/${label}"
      ;;
    enable:2|kickstart:2)
      [[ "${target}" == system/* ]] || fail "unsupported launchctl target: ${target}"
      label="${target#system/}"
      require_label "${label}"
      require_owned_daemon "${label}"
      exec launchctl "${verb}" "system/${label}"
      ;;
    bootout:2)
      if [[ "${target}" == system/* ]]; then
        label="${target#system/}"
        require_label "${label}"
        require_owned_daemon "${label}"
        exec launchctl bootout "system/${label}"
      fi
      # Legacy per-user LaunchAgents, removed while migrating to LaunchDaemons.
      [[ "${target}" == "gui/${caller_uid}/"* ]] || fail "unsupported launchctl target: ${target}"
      label="${target#gui/${caller_uid}/}"
      require_label "${label}"
      exec launchctl bootout "gui/${caller_uid}/${label}"
      ;;
    bootstrap:3)
      [ "${target}" = "system" ] || fail "unsupported launchctl domain: ${target}"
      label="$(basename "$3" .plist)"
      require_label "${label}"
      [ "$3" = "$(daemon_path "${label}")" ] || fail "unsupported plist path: $3"
      require_owned_daemon "${label}"
      exec launchctl bootstrap system "$3"
      ;;
    *)
      fail "unsupported launchctl command: $*"
      ;;
  esac
}

install_plist() {
  local source_path="${7:-}"
  local destination_path="${8:-}"
  local staged
  local label

  [ "$#" -eq 8 ] && [ "$1 $2 $3 $4 $5 $6" = "-o root -g wheel -m 0644" ] ||
    fail "unsupported install arguments: $*"

  staged="$(mktemp /tmp/launchd-helper.XXXXXX)"
  trap 'rm -f "${staged}"' EXIT
  # Read as the caller so a symlinked source cannot expose root-only files.
  sudo -u "${caller_user}" cat -- "${source_path}" > "${staged}" || fail "cannot read ${source_path}"

  label="$(validate_plist "${staged}" "${caller_user}")"
  [ "${destination_path}" = "$(daemon_path "${label}")" ] ||
    fail "destination must be $(daemon_path "${label}")"
  if [ -e "${destination_path}" ] || [ -L "${destination_path}" ]; then
    require_owned_daemon "${label}"
  fi
  install -o root -g wheel -m 0644 "${staged}" "${destination_path}"
}

remove_plist() {
  local label

  [ "$#" -eq 2 ] && [ "$1" = "-f" ] || fail "unsupported rm arguments: $*"
  label="$(basename "$2" .plist)"
  require_label "${label}"
  [ "$2" = "$(daemon_path "${label}")" ] || fail "unsupported plist path: $2"
  if [ ! -e "$2" ] && [ ! -L "$2" ]; then
    return 0
  fi
  require_owned_daemon "${label}"
  rm -f "$2"
}

command="${1:-}"
shift || true
case "${command}" in
  check)
    require_caller
    ;;
  validate)
    [ "$#" -eq 1 ] || fail "usage: validate <plist>"
    validate_plist "$1" "${SUDO_USER:-$(id -un)}"
    ;;
  launchctl)
    require_caller
    run_launchctl "$@"
    ;;
  install)
    require_caller
    install_plist "$@"
    ;;
  rm)
    require_caller
    remove_plist "$@"
    ;;
  *)
    fail "unsupported command: ${command}"
    ;;
esac
