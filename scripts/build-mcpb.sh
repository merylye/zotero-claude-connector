#!/usr/bin/env bash
# Package the extension into dist/zotero-connector-<version>.mcpb
#
# An .mcpb is a zip containing manifest.json, the server code, the icon, and the
# production node_modules, so it installs in Claude Desktop with no toolchain on
# the user's machine.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
OUT="dist/zotero-connector-${VERSION}.mcpb"
STAGE=$(mktemp -d)

npm ci --omit=dev

cp -r manifest.json package.json icon.png server "$STAGE/"
cp -r node_modules "$STAGE/node_modules"

mkdir -p dist
rm -f "$OUT"
(cd "$STAGE" && zip -qr - . -x "*.DS_Store" -x "__MACOSX/*") > "$OUT"
rm -rf "$STAGE"

echo "built $OUT ($(du -h "$OUT" | cut -f1))"
