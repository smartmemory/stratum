#!/usr/bin/env bash
#
# Manual PyPI release for stratum-py + stratum-mcp — a stand-in for
# .github/workflows/publish.yml while GitHub Actions is dormant.
#
# WHY: the smartmemory org's sole owner account (smartmem-dev) is suspended, so
# pushes by it don't trigger Actions (and thus not the OIDC Trusted-Publisher
# upload). This reproduces the CI publish locally with a PyPI API token.
# DELETE this script once CI is restored. The CI workflow remains the source of truth.
#
# The version published is whatever is set in each pyproject.toml. Bump the
# version there (and commit) first — exactly as you would to trigger CI — then
# run this. --skip-existing makes it idempotent (a version already on PyPI is
# skipped, not an error), so re-running is safe.
#
# Usage:
#   scripts/release-manual.sh            # build + publish BOTH packages
#   scripts/release-manual.sh mcp        # only stratum-mcp
#   scripts/release-manual.sh py         # only stratum-py
#   scripts/release-manual.sh --dry-run  # build both + twine check, do NOT upload (no token needed)
#
# Requires (for real upload): PYPI_API_TOKEN = a PyPI API token. Publishes as the
# token's owner. The token is passed via TWINE_PASSWORD env — never on argv/logs.
set -euo pipefail

WHICH="both"; DRY=0
for a in "$@"; do
  case "$a" in
    mcp|py|both) WHICH="$a" ;;
    --dry-run)   DRY=1 ;;
    *) echo "Usage: $0 {both|mcp|py} [--dry-run]" >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ "$DRY" -eq 0 ] && [ -z "${PYPI_API_TOKEN:-}" ]; then
  echo "ERROR: PYPI_API_TOKEN is not set (PyPI API token). Or run with --dry-run to build only." >&2
  exit 1
fi
python3 -c "import build" 2>/dev/null || { echo "ERROR: python 'build' missing — pip install build twine" >&2; exit 1; }
python3 -c "import twine" 2>/dev/null || { echo "ERROR: python 'twine' missing — pip install build twine" >&2; exit 1; }

pyproject_version() {  # $1 = dir
  grep -m1 -E '^[[:space:]]*version[[:space:]]*=' "$1/pyproject.toml" | sed -E 's/.*"([^"]+)".*/\1/'
}

publish_pkg() {  # $1 = subdir ('.' for root/stratum-py) ; $2 = label
  local dir="$1" label="$2" ver
  ver="$(pyproject_version "$dir")"
  echo ">> $label @ ${ver:-?}"
  ( cd "$dir" && rm -rf dist && python3 -m build >/dev/null && python3 -m twine check dist/* )
  if [ "$DRY" -eq 1 ]; then
    echo "   [dry-run] built + checked OK — not uploading"
    return
  fi
  ( cd "$dir" && TWINE_USERNAME=__token__ TWINE_PASSWORD="$PYPI_API_TOKEN" \
      python3 -m twine upload --skip-existing dist/* )
}

# stratum-mcp first (it depends on stratum-py at runtime, so publish the server
# alongside the lib; order is not load-bearing thanks to --skip-existing).
case "$WHICH" in
  both) publish_pkg "stratum-mcp" "stratum-mcp"; publish_pkg "." "stratum-py" ;;
  mcp)  publish_pkg "stratum-mcp" "stratum-mcp" ;;
  py)   publish_pkg "." "stratum-py" ;;
esac

echo ">> done."
