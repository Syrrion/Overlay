#!/usr/bin/env bash
set -euo pipefail

repo_path="${1:-}"
passenger_app_path="${2:-}"
branch="${3:-main}"

if [ -z "$repo_path" ]; then
  echo "Missing repository path" >&2
  exit 1
fi

if [ -z "$passenger_app_path" ]; then
  echo "Missing Passenger app path" >&2
  exit 1
fi

cd "$repo_path"

git fetch origin "$branch"
git checkout "$branch"
git pull --ff-only origin "$branch"

if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

mkdir -p "$passenger_app_path/tmp"
touch "$passenger_app_path/tmp/restart.txt"

echo "Deployment completed for branch $branch"