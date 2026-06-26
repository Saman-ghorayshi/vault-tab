#!/bin/bash
# deploy.sh - stage, commit, and push changes to github
# usage: ./deploy.sh "commit message"

set -e

cd "$(dirname "$0")"

if [ -z "$1" ]; then
  echo "usage: ./deploy.sh \"commit message\""
  exit 1
fi

COMMIT_MESSAGE="$1"

echo "==> staging changes..."
git add -A

echo "==> committing..."
git commit -m "$COMMIT_MESSAGE"

echo "==> pushing..."
git push origin master 2>/dev/null || git push origin main 2>/dev/null || {
  echo "push failed. check your remote:"
  echo "  git remote add origin https://github.com/YOUR_USERNAME/aegis-tab.git"
  exit 1
}

echo "==> done. deployed to github."
