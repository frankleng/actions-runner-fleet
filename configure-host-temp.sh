#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./configure-host-temp.sh [--check | --apply]

With --check (the default), report whether Linux /tmp is disk-backed.
With --apply, configure the
vendor systemd tmp.mount to stay disabled after reboot. --apply requires
root. It never unmounts /tmp, deletes temporary files, or reboots the host.
Existing tmpfs contents disappear on reboot; they are not migrated.
EOF
}

fail() {
  echo "Host temporary storage: $*" >&2
  exit 1
}

mode="${1:---check}"
[ "$#" -le 1 ] || { usage >&2; exit 2; }
case "${mode}" in
  --check|--apply) ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

[ "$(uname -s)" = Linux ] || fail "this command supports Linux only."
[ ! -L /tmp ] || fail "/tmp is a symlink; configure its target separately."
current_type="$(findmnt --noheadings --output FSTYPE --target /tmp)"
case "${current_type}" in
  tmpfs|ramfs) ;;
  *) echo "/tmp currently uses ${current_type}; no change needed."; exit 0 ;;
esac

if [ "${mode}" = --check ]; then
  echo "/tmp uses ${current_type}, which competes with builds for memory." >&2
  if [ "$(systemctl is-enabled tmp.mount 2>/dev/null || true)" = masked ]; then
    echo "tmp.mount is masked; a reboot is still needed to activate the change." >&2
  else
    echo "Configure disk-backed /tmp with: sudo ./configure-host-temp.sh --apply" >&2
  fi
  exit 1
fi

[ "$(id -u)" -eq 0 ] || fail "run --apply as root."
fragment="$(systemctl show tmp.mount --property=FragmentPath --value)"
case "${fragment}" in
  /usr/lib/systemd/system/tmp.mount|/lib/systemd/system/tmp.mount|/etc/systemd/system/tmp.mount) ;;
  ''|/dev/null)
    if [ "$(systemctl is-enabled tmp.mount 2>/dev/null || true)" = masked ]; then
      echo "tmp.mount is already persistently masked; the active /tmp remains ${current_type}."
      echo "Verify disk-backed storage with --check after the scheduled reboot."
      exit 0
    fi
    fail "/tmp has no systemd unit file; configure its mount source separately."
    ;;
  *) fail "/tmp is not backed by the expected systemd unit; configure its mount source separately." ;;
esac
# An fstab entry can mount tmpfs independently of the vendor unit. Refuse
# to edit administrator-owned mounts or promise a change that will not apply.
fstab_entries="$(findmnt --fstab --noheadings --output TARGET)" || {
  # findmnt also exits nonzero for an empty/comment-only fstab. Accept that
  # case, but fail closed if mount records exist and could not be read.
  if [ -e /etc/fstab ] && ! awk 'NF && $1 !~ /^#/ { exit 1 }' /etc/fstab; then
    fail "could not inspect /etc/fstab."
  fi
}
if printf '%s\n' "${fstab_entries}" | grep -Fxq /tmp; then
  fail "/etc/fstab defines /tmp; update that mount explicitly instead."
fi
root_type="$(findmnt --noheadings --output FSTYPE --target /)"
case "${root_type}" in
  tmpfs|ramfs) fail "the root filesystem is also memory-backed." ;;
esac

# No --now: stopping this mount can interrupt jobs, sockets and services.
# systemctl mask refuses to overwrite an administrator's local unit file.
systemctl mask tmp.mount
[ "$(systemctl is-enabled tmp.mount 2>/dev/null || true)" = masked ] ||
  fail "tmp.mount was not persistently masked."
echo "Configured /tmp to use the root filesystem (${root_type}) after reboot."
echo "The active mount is unchanged. Schedule a reboot when host workloads can stop."
echo "Existing tmpfs files will disappear at reboot; copy anything needed first."
df -h /
