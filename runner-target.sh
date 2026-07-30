#!/bin/bash

# Shared GitHub Actions runner-target parsing for the fleet shell entrypoints.
# This file is sourced; do not enable or change the caller's shell options here.

github_runner_scope_from_url() {
  local github_url="${1%/}"

  if [[ "${github_url}" =~ ^https://github\.com/enterprises/[A-Za-z0-9_.-]+$ ]]; then
    printf '%s\n' "enterprise"
    return 0
  fi

  if [[ "${github_url}" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    printf '%s\n' "repository"
    return 0
  fi

  if [[ "${github_url}" =~ ^https://github\.com/[A-Za-z0-9_.-]+$ ]]; then
    printf '%s\n' "organization"
    return 0
  fi

  return 1
}

github_runner_normalize_scope() {
  local scope_input

  scope_input="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "${scope_input}" in
    1|repo|repository)
      printf '%s\n' "repository"
      ;;
    2|org|organization)
      printf '%s\n' "organization"
      ;;
    3|enterprise)
      printf '%s\n' "enterprise"
      ;;
    *)
      return 1
      ;;
  esac
}

github_runner_url_from_scope_and_target() {
  local scope
  local target="${2#/}"

  scope="$(github_runner_normalize_scope "$1")" || return 1
  target="${target%/}"

  case "${scope}" in
    repository)
      [[ "${target}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
      printf 'https://github.com/%s\n' "${target}"
      ;;
    organization)
      [[ "${target}" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
      printf 'https://github.com/%s\n' "${target}"
      ;;
    enterprise)
      [[ "${target}" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
      printf 'https://github.com/enterprises/%s\n' "${target}"
      ;;
  esac
}
