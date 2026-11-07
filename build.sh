#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PLUGIN_DIR"
NAME="routed-model"

echo "==> Setting up test virtual environment..."
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install fastapi httpx

echo "==> Running unit tests..."
./.venv/bin/python -m unittest discover -s tests -v

echo "==> Building distribution archives..."
mkdir -p dist
rm -f dist/*.tar.gz dist/*.zip dist/SHA256SUMS

# Stage the runtime tree under a top-level $NAME/ folder so the archive
# extracts to $HERMES_HOME/plugins/$NAME regardless of the checkout's own
# directory name (GitHub checks repos out as <repo>/, not <plugin>/).
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME"
(cd "$PLUGIN_DIR" && tar --exclude="./dist" --exclude="./tests" --exclude="./.venv" \
    --exclude="./.git" --exclude="./.github" --exclude="__pycache__" --exclude="*.pyc" \
    -cf - .) | tar -xf - -C "$STAGE/$NAME"

tar -czf "dist/$NAME-0.1.0.tar.gz" -C "$STAGE" "$NAME"

NAME="$NAME" STAGE="$STAGE" PLUGIN_DIR="$PLUGIN_DIR" python3 - <<'PYEOF'
import os, zipfile
name = os.environ["NAME"]
stage = os.environ["STAGE"]
out = os.path.join(os.environ["PLUGIN_DIR"], "dist", f"{name}-0.1.0.zip")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirnames, filenames in os.walk(os.path.join(stage, name)):
        for f in filenames:
            p = os.path.join(dirpath, f)
            z.write(p, os.path.relpath(p, stage))
print("zip written:", out)
PYEOF

echo "==> Generating checksum manifest..."
cd dist
sha256sum routed-model-0.1.0.tar.gz routed-model-0.1.0.zip > SHA256SUMS
cat SHA256SUMS
cd "$PLUGIN_DIR"

echo "==> Verifying archive structure..."
tar -tzf dist/routed-model-0.1.0.tar.gz

echo "==> Build complete in dist/"
ls -lh dist/
