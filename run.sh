#!/bin/sh
set -eu

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-5722}"
MCP_PATH="${MCP_PATH:-/mcp-bukken-q7v5f2}"

export HOST PORT MCP_PATH
exec node build/index.js
