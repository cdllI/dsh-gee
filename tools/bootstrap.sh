#!/usr/bin/env bash
# Create the Earth Engine Python environment for dsh-gee.
#
# The mirror default matters: pip through a proxy is the slowest part of setup,
# and a domestic mirror turns a ten-minute install into seconds.
#
#   sh tools/bootstrap.sh [venv-dir]
set -euo pipefail

VENV="${1:-.venv}"
INDEX="${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple}"

if [ ! -d "$VENV" ]; then
  echo "creating $VENV"
  python3 -m venv "$VENV"
fi

# --no-cache-dir avoids a stale cache lock left by an interrupted run.
"$VENV/bin/pip" install --no-cache-dir --progress-bar off -i "$INDEX" earthengine-api
"$VENV/bin/pip" show earthengine-api | grep '^Version:'

echo
echo "next: authenticate and write the config"
echo "  $VENV/bin/earthengine authenticate"
echo "  cp dsh-gee/gee.config.example.json dsh-gee/gee.config.json  # then fill it in"
