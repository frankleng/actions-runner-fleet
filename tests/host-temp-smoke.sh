#!/bin/bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$(uname -s)" != Linux ] || [ -L /tmp ]; then
  echo 'Host temporary storage smoke test requires Linux with a nonsymlink /tmp; skipped'
  exit 0
fi
test_root="$(mktemp -d "${ROOT_DIR}/.host-temp-test.XXXXXX")"
trap 'rm -rf "${test_root}"' EXIT
mkdir "${test_root}/bin"
export HOST_TEMP_TEST_STATE="${test_root}"
export PATH="${test_root}/bin:${PATH}"

cat > "${test_root}/bin/uname" <<'EOF'
#!/bin/bash
echo Linux
EOF
cat > "${test_root}/bin/id" <<'EOF'
#!/bin/bash
echo "${TEST_UID:-0}"
EOF
cat > "${test_root}/bin/findmnt" <<'EOF'
#!/bin/bash
if [ "$1" = --fstab ]; then
  [ "${TEST_FSTAB_FAILURE:-0}" = 0 ] || exit 1
  printf '%s\n' "${TEST_FSTAB_TARGET:-/}"
elif [ "${!#}" = / ]; then
  echo "${TEST_ROOT_TYPE:-ext4}"
else
  echo "${TEST_TMP_TYPE:-tmpfs}"
fi
EOF
cat > "${test_root}/bin/awk" <<'EOF'
#!/bin/bash
# Model the record check after findmnt reports no entries or an error.
[ "${TEST_FSTAB_EMPTY:-0}" = 1 ]
EOF
cat > "${test_root}/bin/systemctl" <<'EOF'
#!/bin/bash
set -eu
case "$*" in
  'show tmp.mount --property=FragmentPath --value')
    echo "${TEST_FRAGMENT-/usr/lib/systemd/system/tmp.mount}" ;;
  'is-enabled tmp.mount')
    if [ -f "${HOST_TEMP_TEST_STATE}/masked" ]; then echo masked; else echo static; fi ;;
  'mask tmp.mount')
    [ "${TEST_MASK_FAIL:-0}" = 0 ] || exit 1
    touch "${HOST_TEMP_TEST_STATE}/masked"
    echo mask >> "${HOST_TEMP_TEST_STATE}/mutations" ;;
  *) echo "Unexpected systemctl mutation: $*" >&2; exit 99 ;;
esac
EOF
cat > "${test_root}/bin/df" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "${test_root}/bin/"*

expect_failure() {
  if "$@" > "${test_root}/output" 2>&1; then
    echo "Expected rejection: $*" >&2
    exit 1
  fi
}

# Read-only checks must never mask a mount, including pending-reboot checks.
expect_failure bash "${ROOT_DIR}/configure-host-temp.sh" --check
[ ! -e "${test_root}/mutations" ]
TEST_TMP_TYPE=ext4 bash "${ROOT_DIR}/configure-host-temp.sh" --check
TEST_TMP_TYPE=ext4 bash "${ROOT_DIR}/configure-host-temp.sh" --apply
[ ! -e "${test_root}/mutations" ]

# Reject unsafe/conflicting configurations before touching systemd.
expect_failure env TEST_UID=1000 bash "${ROOT_DIR}/configure-host-temp.sh" --apply
expect_failure env TEST_FRAGMENT= bash "${ROOT_DIR}/configure-host-temp.sh" --apply
expect_failure env TEST_FSTAB_TARGET=/tmp bash "${ROOT_DIR}/configure-host-temp.sh" --apply
expect_failure env TEST_ROOT_TYPE=tmpfs bash "${ROOT_DIR}/configure-host-temp.sh" --apply
expect_failure env TEST_MASK_FAIL=1 bash "${ROOT_DIR}/configure-host-temp.sh" --apply
if [ -e /etc/fstab ]; then
  expect_failure env TEST_FSTAB_FAILURE=1 bash "${ROOT_DIR}/configure-host-temp.sh" --apply
fi
[ ! -e "${test_root}/mutations" ]

# Applying is repeatable and only masks: no stop, unmount, or reboot commands.
bash "${ROOT_DIR}/configure-host-temp.sh" --apply
bash "${ROOT_DIR}/configure-host-temp.sh" --apply
TEST_FSTAB_FAILURE=1 TEST_FSTAB_EMPTY=1 bash "${ROOT_DIR}/configure-host-temp.sh" --apply
TEST_FRAGMENT=/dev/null bash "${ROOT_DIR}/configure-host-temp.sh" --apply
TEST_FRAGMENT= bash "${ROOT_DIR}/configure-host-temp.sh" --apply
[ "$(wc -l < "${test_root}/mutations")" -eq 3 ]
expect_failure bash "${ROOT_DIR}/configure-host-temp.sh" --check
[ "$(wc -l < "${test_root}/mutations")" -eq 3 ]
TEST_TMP_TYPE=ext4 bash "${ROOT_DIR}/configure-host-temp.sh" --check
echo 'Host temporary storage smoke test passed'
