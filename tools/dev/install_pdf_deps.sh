#!/usr/bin/env bash
# Chromium's libraries and Arabic fonts for server-side PDFs. The dev image ships neither,
# and they vanish when the container is recreated, so this runs on every setup and start.
set -eu
. "$(dirname "$(readlink -f "$0")")/lib.sh"
docker exec -u 0 "$FRAPPE_CONTAINER" sh -c '
  if dpkg -s libatk-bridge2.0-0 fonts-noto-core >/dev/null 2>&1 || dpkg -s libatk-bridge2.0-0t64 fonts-noto-core >/dev/null 2>&1; then
    exit 0
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libnss3 libgbm1 libasound2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libcups2 libpango-1.0-0 libcairo2 \
    fontconfig fonts-noto-core >/dev/null
  fc-cache -f
'
