#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST=""
REPO_ROOT="."
REQUIRE_DIGEST="false"

usage() {
  cat <<'USAGE'
Usage: validate-sbom-manifest.sh --manifest PATH [--repo-root PATH] [--require-digest]
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)
      MANIFEST="$2"
      shift 2
      ;;
    --repo-root)
      REPO_ROOT="$2"
      shift 2
      ;;
    --require-digest)
      REQUIRE_DIGEST="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$MANIFEST" ]]; then
  usage >&2
  exit 2
fi

args=(--manifest "$MANIFEST" --repo-root "$REPO_ROOT")
if [[ "$REQUIRE_DIGEST" == "true" ]]; then
  args+=(--require-digest)
fi

exec python3 "${ROOT_DIR}/scripts/validate_sbom_manifest.py" "${args[@]}"
