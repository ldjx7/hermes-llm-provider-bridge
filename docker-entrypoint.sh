#!/bin/sh
set -eu

BRIDGE_CONFIG="${BRIDGE_CONFIG:-/config/bridge.config.json}"

if [ ! -f "$BRIDGE_CONFIG" ]; then
  mkdir -p "$(dirname "$BRIDGE_CONFIG")"
  cp "/app/bridge.config.example.json" "$BRIDGE_CONFIG"
  echo "Created default bridge config at $BRIDGE_CONFIG"
fi

exec "$@"
