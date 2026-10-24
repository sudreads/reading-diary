#!/usr/bin/env bash
# Publish reading-diary/ as committed at HEAD to github.com/sudreads/reading-diary.
# Each run adds one commit to the PUBLIC repo's own history; the private monorepo history
# never leaves this machine. Commits use the GitHub noreply address, never a real email.
# Bump CACHE in sw.js before publishing a change, or installed phones keep the old version.
set -euo pipefail

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
pub="$root/.publish/reading-diary"
remote="https://github.com/sudreads/reading-diary.git"

if [ ! -d "$pub/.git" ]; then
  git clone -q "$remote" "$pub"
fi
git -C "$pub" fetch -q origin || true
git -C "$pub" checkout -q -B main
git -C "$pub" reset -q --hard origin/main 2>/dev/null || true # empty repo on first run

find "$pub" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "$root" archive HEAD reading-diary | tar -x -C "$pub" --strip-components=1

id=$(gh api user --jq .id)
git -C "$pub" add -A
if git -C "$pub" diff --cached --quiet; then echo "Nothing new to publish."; exit 0; fi
git -C "$pub" -c user.name="sudreads" -c user.email="${id}+sudreads@users.noreply.github.com" \
  commit -q -m "${1:-Update Reading Diary}"
git -C "$pub" push -q -u origin main
echo "Published: https://sudreads.github.io/reading-diary/"
