#!/usr/bin/env sh
set -e

echo "Starting goai-tools-mcp with NODE_ENV=${NODE_ENV:-production} PORT=${PORT:-3000}"

exec node server.js
