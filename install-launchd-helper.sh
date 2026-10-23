#!/bin/bash
# Installs launchd-helper.sh as a root-owned command and lets the invoking
# account run it through sudo without a password, so runner LaunchDaemons can be
# installed, started, stopped, and removed without an administrator prompt.
#
#   sudo ./install-launchd-helper.sh             install or update the helper
#   sudo ./install-launchd-helper.sh --uninstall remove the helper and sudo rule

set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
umask 022

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR=/usr/local/libexec/actions-runner-fleet
HELPER_PATH="${HELPER_DIR}/launchd-helper"
SUDOERS_PATH=/etc/sudoers.d/actions-runner-fleet

fail() {
  echo "$*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "the launchd helper is only used on macOS"
[ "$(id -u)" -eq 0 ] || fail "run with sudo: sudo $0 $*"
account="${SUDO_USER:-}"
[ -n "${account}" ] && [ "${account}" != "root" ] ||
  fail "run with sudo from the account that owns the runners"
[[ "${account}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || fail "unsupported account name: ${account}"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "${SUDOERS_PATH}" "${HELPER_PATH}"
  rmdir "${HELPER_DIR}" 2>/dev/null || true
  echo "removed ${HELPER_PATH} and ${SUDOERS_PATH}"
  exit 0
fi
[ "$#" -eq 0 ] || fail "usage: sudo $0 [--uninstall]"

install -d -o root -g wheel -m 0755 "${HELPER_DIR}"
# The account must not be able to replace the helper through any parent directory.
dir="${HELPER_DIR}"
while [ "${dir}" != "/" ]; do
  [ ! -L "${dir}" ] || fail "${dir} is a symlink"
  [ "$(stat -f '%u' "${dir}")" = "0" ] || fail "${dir} is not owned by root"
  case "$(stat -f '%Sp' "${dir}")" in
    ?????w????|????????w?) fail "${dir} is writable by non-root users" ;;
  esac
  dir="$(dirname "${dir}")"
done

install -o root -g wheel -m 0755 "${SCRIPT_DIR}/launchd-helper.sh" "${HELPER_PATH}"

staged_sudoers="$(mktemp /tmp/actions-runner-fleet-sudoers.XXXXXX)"
trap 'rm -f "${staged_sudoers}"' EXIT
cat > "${staged_sudoers}" <<EOF
# Managed by actions-runner-fleet/install-launchd-helper.sh.
# The helper validates every request and only manages ${account}'s runner LaunchDaemons.
${account} ALL=(root) NOPASSWD: ${HELPER_PATH}
EOF
visudo -c -q -f "${staged_sudoers}" || fail "generated sudoers rule failed validation"
install -o root -g wheel -m 0440 "${staged_sudoers}" "${SUDOERS_PATH}"

echo "installed ${HELPER_PATH}"
echo "${account} can now manage runner LaunchDaemons without a password"
