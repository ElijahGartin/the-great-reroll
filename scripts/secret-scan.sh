#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/secret-scan.sh [git|dir]

  git  scan committed Git history reachable from the checkout
  dir  scan the current working tree
USAGE
}

MODE="${1:-git}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${GITLEAKS_CONFIG:-$ROOT_DIR/gitleaks.toml}"

if [[ "$MODE" == "-h" || "$MODE" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is required for secret scanning. Install it locally or on the Jenkins agent." >&2
  exit 127
fi

case "$MODE" in
  git)
    exec gitleaks git --config "$CONFIG_PATH" --redact --verbose "$ROOT_DIR"
    ;;
  dir)
    exec gitleaks dir --config "$CONFIG_PATH" --redact --verbose "$ROOT_DIR"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
