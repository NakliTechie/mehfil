#!/bin/bash
# Regenerate the Mehfil guide: capture screenshots, then build the HTML.
set -e
cd "$(dirname "$0")/.."
node guide/capture.mjs
node guide/build.mjs
echo "guide regenerated → guide/index.html"
