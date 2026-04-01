#!/bin/sh
set -eu

mkdir -p /workspace/site /workspace/netlify-state /workspace/data
chown -R appuser:appuser /workspace/site /workspace/netlify-state /workspace/data
mkdir -p /home/appuser/.npm
chown -R appuser:appuser /home/appuser

exec setpriv --reuid=10001 --regid=10001 --init-groups node /app/src/index.mjs
