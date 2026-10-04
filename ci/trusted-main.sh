#!/usr/bin/env bash
# A second guard at the publication boundary; this job must only load trusted main.
set -euo pipefail
if [[ -n "${CHANGE_ID:-}${CHANGE_TARGET:-}${CHANGE_BRANCH:-}" ]]; then
  echo 'Publication is forbidden for pull requests' >&2
  exit 1
fi
case "${BRANCH_NAME:-${GIT_BRANCH:-}}" in
  main|origin/main) ;;
  *) echo 'Publication requires an explicit main branch build' >&2; exit 1 ;;
esac
[[ "${BUILD_NUMBER:-}" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid build number' >&2; exit 1; }
git config --global --add safe.directory "${WORKSPACE:-$PWD}"
head="$(git rev-parse HEAD)"
[[ "${GIT_COMMIT:-}" == "$head" ]] || { echo 'Checkout differs from Jenkins source revision' >&2; exit 1; }
remote="$(git ls-remote --exit-code origin refs/heads/main | cut -f1)"
[[ "$head" == "$remote" ]] || { echo 'Checkout is not current trusted main' >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo 'Tracked source was modified' >&2; exit 1; }
