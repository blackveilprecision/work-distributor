#!/usr/bin/env bash
# Publishes the release for package.json's version, run on a Mac: GitHub's hosted macOS runners are too scarce to rely on,
# so the macOS binaries are built and signed here. Publishing the release starts .github/workflows/release.yml, which adds
# the Linux binaries and SHA256SUMS and commits Formula/wd.rb to main.
set -euo pipefail
cd "$(dirname "$0")/.."

[ "$(uname -s)" = Darwin ] || { echo "run this on a Mac (it builds and signs the macOS binaries)"; exit 1; }
v=$(bun -e 'console.log((await Bun.file("package.json").json()).version)')
[ -z "$(git status --porcelain)" ] || { echo "the working tree is not clean"; exit 1; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "HEAD is not origin/main: push or pull first"; exit 1; }
if gh release view "v$v" >/dev/null 2>&1; then echo "v$v is already released: bump version in package.json"; exit 1; fi

bun install --frozen-lockfile
bunx tsc --noEmit
bun test

rm -rf dist/release && mkdir -p dist/release
for t in darwin-arm64 darwin-x64; do bun build --compile --target=bun-$t src/main.ts --outfile dist/release/wd-$t; done
# Apple silicon runs only signed binaries; an ad-hoc signature is enough for brew and curl downloads.
codesign --force --sign - dist/release/wd-darwin-arm64 dist/release/wd-darwin-x64
[ "$(dist/release/wd-darwin-$( [ "$(uname -m)" = arm64 ] && echo arm64 || echo x64) --version)" = "$v" ]

# The binaries are built from the working tree: refuse to publish them if it changed while the checks and builds ran.
[ -z "$(git status --porcelain)" ] && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "the tree changed during the release: not publishing"; exit 1; }
gh release create "v$v" dist/release/wd-darwin-arm64 dist/release/wd-darwin-x64 --target "$(git rev-parse HEAD)" --title "wd $v" --generate-notes
echo "released v$v with the macOS binaries; the release workflow adds the Linux ones and updates Formula/wd.rb"
