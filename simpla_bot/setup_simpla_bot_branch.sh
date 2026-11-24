#!/usr/bin/env bash
# =============================================================================
# Create and push the `simpla_bot` branch from your local Git clone.
# Run from the repository root after syncing or pulling these files:
#   bash simpla_bot/setup_simpla_bot_branch.sh
# =============================================================================
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: Run this script inside your local git repository clone."
  exit 1
fi

echo "Creating (or switching to) branch: simpla_bot ..."
git checkout -B simpla_bot

git add simpla_bot/
git commit -m "Add simpla_bot standalone MaixSense + normal motor driver + flame/grinder stack and manual" || true

echo ""
echo "Branch 'simpla_bot' is ready locally."
echo "Push to GitHub with:"
echo "  git push -u origin simpla_bot"
