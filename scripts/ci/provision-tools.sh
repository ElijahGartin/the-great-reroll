#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-yaml
python3 ci/install-tools.py
# Jenkins checkout and builder containers use different UIDs; trust only this checkout.
git config --global --add safe.directory "${WORKSPACE:-$PWD}"
