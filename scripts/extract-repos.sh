#!/usr/bin/env bash
# Milestone 5.6 (X10, ADR 0007): extract per-service directories into
# standalone repositories and push them to GitHub.
#
# The workspace overlay is a build convenience; at release each package or
# service becomes its own repo. This script:
#   1. copies the directory into a staging tree,
#   2. injects the shared CI workflow, license, and .gitignore,
#   3. rewrites the @axiom-ai/core dependency to a published semver,
#   4. creates a fresh git repo and pushes to the configured remote org.
#
# Usage:
#   scripts/extract-repos.sh --dry-run                    # stage + show plan only
#   scripts/extract-repos.sh --org <github-org-or-user> [--branch master]
#
# Cross-cutting assets (compose stacks, deploy/, docs/, scripts/, ADRs)
# belong in `axiom-meta` and are NOT handled here (see ADR 0007).

set -euo pipefail

ORG=""
BRANCH="master"
DRY_RUN=false
CORE_VERSION="1.0.0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --org) ORG="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$(mktemp -d)/axiom-extract"
mkdir -p "$STAGE"

# source dir -> repo name (ADR 0007)
declare -A MAPPING=(
  ["packages/core-shared"]="axiom-core-shared"
  ["services/gateway"]="axiom-gateway"
  ["services/rag-pipeline"]="axiom-rag-pipeline"
  ["services/agent-runtime"]="axiom-agent-runtime"
  ["services/ops-observability"]="axiom-ops-observability"
)

copy_shared_assets() {
  local dest="$1"
  mkdir -p "$dest/.github/workflows"
  cp "$REPO_ROOT/.github/workflows/ci.yml" "$dest/.github/workflows/ci.yml" 2>/dev/null || true
  cp "$REPO_ROOT/.github/workflows/security.yml" "$dest/.github/workflows/security.yml" 2>/dev/null || true
  cp "$REPO_ROOT/LICENSE" "$dest/LICENSE" 2>/dev/null || true
  cp "$REPO_ROOT/.gitignore" "$dest/.gitignore" 2>/dev/null || true
}

extract_one() {
  local src="$1"
  local repo="$2"
  local dest="$STAGE/$repo"
  echo "-- extracting $src -> $repo"
  mkdir -p "$dest"
  rsync -a --exclude node_modules --exclude .venv --exclude dist --exclude __pycache__ \
    "$REPO_ROOT/$src/" "$dest/"

  copy_shared_assets "$dest"

  # Rewrite workspace core dependency to the published version.
  if [[ -f "$dest/package.json" ]]; then
    sed -i "s|\"@axiom-ai/core\": \"[^']*\"|\"@axiom-ai/core\": \"^$CORE_VERSION\"|" "$dest/package.json"
  fi

  if [[ "$DRY_RUN" == true ]]; then
    echo "   [dry-run] staged at $dest ($(find "$dest" -type f | wc -l) files)"
    return
  fi

  if [[ -z "$ORG" ]]; then
    echo "   error: --org required unless --dry-run"; exit 2
  fi

  git -C "$dest" init -q -b "$BRANCH"
  git -C "$dest" add -A
  git -C "$dest" commit -q -m "chore: extract from axiom-ai monorepo (ADR 0007), core ^$CORE_VERSION"
  git -C "$dest" remote add origin "git@github.com:$ORG/$repo.git"
  echo "   staged repo ready: $dest (origin: $ORG/$repo, branch: $BRANCH)"
  echo "   push manually with: git -C $dest push -u origin $BRANCH"
}

echo "staging root: $STAGE"
for src in "${!MAPPING[@]}"; do
  extract_one "$src" "${MAPPING[$src]}"
done

echo
if [[ "$DRY_RUN" == true ]]; then
  echo "dry-run complete. inspect $STAGE, then rerun with --org <name>"
else
  echo "extraction complete. review each staged repo, then push when ready."
fi
