#!/usr/bin/env sh
set -e

echo "Starting goai-tools-mcp (dev) with NODE_ENV=${NODE_ENV:-development} PORT=${PORT:-3000}"

exec node server.js
