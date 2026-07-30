#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

fail() {
  echo "security audit failed: $*" >&2
  exit 1
}

git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  fail "run this from a Git checkout"

tracked_path_violation="$(
  git ls-files |
    grep -E -m 1 '(^|/)(\.credentials[^/]*|\.runner[^/]*|\.env|\.path|fleet\.tsv|runners\.tsv|_work|_diag|host-tools|dist)(/|$)|\.(p12|pfx|pem|key|mobileprovision|tar\.gz|pkg)$' ||
    true
)"
[ -z "${tracked_path_violation}" ] ||
  fail "machine-local or credential-bearing path is tracked: ${tracked_path_violation}"

secret_pattern='-----BEGIN ([A-Z ]+)?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|sk_live_[A-Za-z0-9]{16,}|https://hooks\.slack\.com/services/[A-Za-z0-9/_-]{20,}'
secret_hit_files="$(
  git grep --cached -I -l -E -e "${secret_pattern}" -- . 2>/dev/null || true
)"
[ -z "${secret_hit_files}" ] || {
  printf 'potential credential format found in:\n%s\n' "${secret_hit_files}" >&2
  exit 1
}

if [ -n "${HOME:-}" ] && [ -d "${HOME}" ]; then
  source_home_path="$(cd "${HOME}" && pwd -P)"
  home_path_hit_files="$(
    git grep --cached -I -l -F "${source_home_path}" -- . 2>/dev/null || true
  )"
  [ -z "${home_path_hit_files}" ] || {
    printf 'source-machine home path found in:\n%s\n' "${home_path_hit_files}" >&2
    exit 1
  }
fi

echo "security audit passed: no tracked runner state, credential files, private-key formats, known token formats, or source-home paths"
