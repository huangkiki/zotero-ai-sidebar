# Release Flow

This project releases XPI files from Git tags. The local machine only commits and pushes a tag; GitHub Actions builds and publishes the release assets.

## One-time setup

Add a GitHub remote if the repository does not have one yet:

```bash
git remote add origin https://github.com/xuhan-rgb/zotero-ai-sidebar.git
```

If you choose another repository, update `package.json` first so generated Zotero update links point at the same GitHub repo.

Push the main branch once:

```bash
git push -u origin master
```

## Normal release

1. Bump the package version and commit local changes:

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v0.1.1"
```

For a feature or fix commit before a release, use the normal commit flow:

```bash
git add -A
git commit -m "feat: describe change"
```

2. Push the branch and create/push the matching tag with the helper script:

```bash
npm run release:tag -- v0.1.1
```

The script checks that the working tree is clean, verifies the tag matches `package.json` version, creates an annotated tag if needed, pushes the current branch, and pushes the tag.

When the tag reaches GitHub, `.github/workflows/release.yml` automatically runs:

- `npm ci`
- `npm test`
- `npm run build`
- uploads `.scaffold/build/*.xpi` and `.scaffold/build/update*.json` to the version release
- uploads `.scaffold/build/update*.json` to the rolling `release` release for Zotero automatic updates

## Manual release from GitHub UI

The same workflow also supports `workflow_dispatch`. Run **Release XPI** in GitHub Actions, enter a tag like `v0.1.1`, and the workflow will create the tag if needed, build the XPI, and publish the release.

## Notes

- Do not commit local XPI build artifacts. `*.xpi` is ignored by `.gitignore`.
- Local provider configuration such as API keys, Base URL, and model IDs stays in Zotero prefs, not source code.
- Release tags should start with `v`, for example `v0.1.0`.
