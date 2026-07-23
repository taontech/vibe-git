#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found"
    exit 1
fi

if [ ! -d ".venv" ]; then
    echo "[setup] Creating virtual environment..."
    python3 -m venv .venv
fi

source .venv/bin/activate

if ! python3 -c "import fastapi, websockets" 2>/dev/null; then
    echo "[setup] Installing dependencies..."
    pip install -q -r requirements.txt
fi

echo ""
echo "============================================"
echo "  Agent Monitor Server"
echo "============================================"
echo ""

exec python3 server.py "$@"
