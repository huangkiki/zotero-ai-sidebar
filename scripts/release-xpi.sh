#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  npm run release:xpi
  npm run release:xpi -- v0.1.2
  npm run release:xpi -- --republish
  npm run release:xpi -- v0.1.2 --republish

What it does:
  1. Read the release version from package.json.
  2. Verify the working tree is clean.
  3. Run tests and build the XPI locally.
  4. Create an annotated git tag v<package.version> if needed.
  5. Push the current branch and tag.
  6. Wait for GitHub Actions Release XPI.
  7. Print the final GitHub Release and XPI URL.

Options:
  --no-watch     Do not wait for the GitHub Actions release run.
  --prerelease   Mark the GitHub Release as prerelease when using workflow_dispatch.
  --republish    Recreate/upload the GitHub Release for an existing tag without moving the tag.
USAGE
}

REQUESTED_TAG=""
WATCH=1
PRERELEASE=false
REPUBLISH=0
REMOTE="${REMOTE:-origin}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-watch)
      WATCH=0
      shift
      ;;
    --prerelease)
      PRERELEASE=true
      shift
      ;;
    --republish)
      REPUBLISH=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      if [[ -n "$REQUESTED_TAG" ]]; then
        echo "Only one tag argument is allowed." >&2
        usage
        exit 2
      fi
      REQUESTED_TAG="$1"
      shift
      ;;
  esac
done

PACKAGE_VERSION="$(node -p "require('./package.json').version")"
TAG="v$PACKAGE_VERSION"

if [[ -n "$REQUESTED_TAG" ]]; then
  case "$REQUESTED_TAG" in
    v*) ;;
    *) REQUESTED_TAG="v$REQUESTED_TAG" ;;
  esac
  if [[ "$REQUESTED_TAG" != "$TAG" ]]; then
    echo "Requested tag $REQUESTED_TAG does not match package.json version $PACKAGE_VERSION." >&2
    echo "Update package.json first, commit it, then rerun this script." >&2
    exit 2
  fi
fi

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  echo "Cannot release from a detached HEAD." >&2
  exit 2
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "Remote '$REMOTE' is not configured." >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI 'gh' is required." >&2
  exit 2
fi

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
if [[ -z "$REPO" ]]; then
  echo "Cannot infer GitHub repo from the current directory." >&2
  exit 2
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Use /auto-commit or commit/stash changes first." >&2
  git status --short >&2
  exit 2
fi

npm test
npm run build

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  if [[ "$(git rev-list -n 1 "$TAG")" != "$(git rev-parse HEAD)" ]]; then
    echo "Local tag $TAG already exists but does not point at HEAD." >&2
    echo "Use a new version or delete the incorrect local tag manually." >&2
    exit 2
  fi
else
  git tag -a "$TAG" -m "Release $TAG"
fi

REMOTE_TAG_EXISTS=0
if git ls-remote --exit-code --tags "$REMOTE" "refs/tags/$TAG" >/dev/null 2>&1; then
  REMOTE_TAG_EXISTS=1
  REMOTE_TAG_TARGET="$(git ls-remote --tags "$REMOTE" "refs/tags/$TAG^{}" | awk '{print $1}' | head -n 1)"
  if [[ -z "$REMOTE_TAG_TARGET" ]]; then
    REMOTE_TAG_TARGET="$(git ls-remote --tags "$REMOTE" "refs/tags/$TAG" | awk '{print $1}' | head -n 1)"
  fi
  if [[ -n "$REMOTE_TAG_TARGET" && "$REMOTE_TAG_TARGET" != "$(git rev-parse HEAD)" ]]; then
    echo "Remote tag $TAG already exists but does not point at HEAD." >&2
    echo "Use a new version or delete the incorrect remote tag manually." >&2
    exit 2
  fi
fi

if git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
  git push "$REMOTE" "$BRANCH"
else
  git push -u "$REMOTE" "$BRANCH"
fi

if [[ "$REMOTE_TAG_EXISTS" -eq 0 ]]; then
  git push "$REMOTE" "refs/tags/$TAG"
else
  echo "Remote tag $TAG already exists."
fi

if [[ "$REMOTE_TAG_EXISTS" -eq 1 || "$REPUBLISH" -eq 1 ]]; then
  echo "Triggering Release XPI workflow for $TAG."
  gh workflow run "Release XPI" --repo "$REPO" --ref "$BRANCH" \
    -f "tag=$TAG" -f "prerelease=$PRERELEASE"
fi

if [[ "$WATCH" -eq 1 ]]; then
  RUN_ID=""
  for _ in {1..20}; do
    RUN_ID="$(gh run list --repo "$REPO" --workflow "Release XPI" --limit 10 \
      --json databaseId,headBranch,event \
      --jq "map(select(.headBranch == \"$TAG\" or .event == \"workflow_dispatch\")) | first | .databaseId // empty")"
    if [[ -n "$RUN_ID" ]]; then
      break
    fi
    sleep 3
  done

  if [[ -z "$RUN_ID" ]]; then
    echo "Could not find the Release XPI workflow run. Check GitHub Actions manually." >&2
    exit 1
  fi

  gh run watch "$RUN_ID" --repo "$REPO" --exit-status
  gh release view "$TAG" --repo "$REPO" --json url,assets \
    --jq '"Release: " + .url, (.assets[] | "Asset: " + .name + " " + .url)'
fi
