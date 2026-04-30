#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-}"
REMOTE="${REMOTE:-origin}"
BRANCH="$(git branch --show-current)"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"

if [[ -z "$TAG" ]]; then
  echo "Usage: npm run release:tag -- v0.1.0" >&2
  exit 2
fi

case "$TAG" in
  v*) ;;
  *) echo "Release tag must start with v, got: $TAG" >&2; exit 2 ;;
esac

if [[ "$TAG" != "v$PACKAGE_VERSION" ]]; then
  echo "Tag $TAG does not match package.json version $PACKAGE_VERSION." >&2
  echo "Bump package.json first, then commit it before releasing." >&2
  exit 2
fi

if [[ -z "$BRANCH" ]]; then
  echo "Cannot release from a detached HEAD." >&2
  exit 2
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "Remote '$REMOTE' is not configured. Add it first, for example:" >&2
  echo "  git remote add origin git@github.com:<owner>/<repo>.git" >&2
  exit 2
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes before tagging." >&2
  git status --short >&2
  exit 2
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  if [[ "$(git rev-list -n 1 "$TAG")" != "$(git rev-parse HEAD)" ]]; then
    echo "Tag $TAG already exists but does not point at HEAD." >&2
    exit 2
  fi
  echo "Tag $TAG already exists locally." >&2
else
  git tag -a "$TAG" -m "Release $TAG"
fi

if git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
  git push "$REMOTE" "$BRANCH"
else
  git push -u "$REMOTE" "$BRANCH"
fi
git push "$REMOTE" "refs/tags/$TAG"

echo "Pushed $BRANCH and $TAG. GitHub Actions will build and publish the XPI release."
