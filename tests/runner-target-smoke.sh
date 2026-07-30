#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../runner-target.sh
source "${ROOT_DIR}/runner-target.sh"

[ "$(github_runner_scope_from_url "https://github.com/example-org")" = "organization" ]
[ "$(github_runner_scope_from_url "https://github.com/example-user/example-repo/")" = "repository" ]
[ "$(github_runner_scope_from_url "https://github.com/enterprises/example-enterprise")" = "enterprise" ]

[ "$(github_runner_normalize_scope "repo")" = "repository" ]
[ "$(github_runner_normalize_scope "2")" = "organization" ]
[ "$(github_runner_normalize_scope "ENTERPRISE")" = "enterprise" ]

[ "$(github_runner_url_from_scope_and_target "repository" "example-user/example-repo")" = \
  "https://github.com/example-user/example-repo" ]
[ "$(github_runner_url_from_scope_and_target "org" "example-org")" = \
  "https://github.com/example-org" ]
[ "$(github_runner_url_from_scope_and_target "3" "example-enterprise")" = \
  "https://github.com/enterprises/example-enterprise" ]

if github_runner_scope_from_url "https://github.com/example/too/many" >/dev/null; then
  echo "expected an unsupported GitHub target URL to be rejected"
  exit 1
fi

if github_runner_url_from_scope_and_target "repository" "missing-repository" >/dev/null; then
  echo "expected a malformed repository target to be rejected"
  exit 1
fi
