#!/usr/bin/env bash
#
# Cut a release: bump the workspace versions, tag, push, and let CI build and
# publish the image to GHCR.
#
#   scripts/release.sh patch          1.0.0 -> 1.0.1
#   scripts/release.sh minor          1.0.0 -> 1.1.0
#   scripts/release.sh major          1.0.0 -> 2.0.0
#   scripts/release.sh 2.3.0          explicit version
#
#   --no-verify   skip the local typecheck/test run (CI still gates the release)
#   --dry-run     show what would happen, change nothing

set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE='ghcr.io/roandegraaf/fling'
BUMP=''
VERIFY=1
DRY_RUN=0

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\033[36m==>\033[0m %s\n' "$*"; }
run() { if (( DRY_RUN )); then printf '   would run: %s\n' "$*"; else "$@"; fi; }

while (( $# )); do
  case "$1" in
    --no-verify) VERIFY=0 ;;
    --dry-run)   DRY_RUN=1 ;;
    -h|--help)   sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)          die "unknown flag: $1" ;;
    *)           [[ -n "$BUMP" ]] && die "give exactly one version argument"; BUMP="$1" ;;
  esac
  shift
done

[[ -n "$BUMP" ]] || die "usage: scripts/release.sh <patch|minor|major|X.Y.Z> [--no-verify] [--dry-run]"

# ── preflight ────────────────────────────────────────────────────────────────
step 'Checking preconditions'

command -v git >/dev/null || die 'git is not installed'
command -v gh  >/dev/null || die 'the GitHub CLI (gh) is not installed'
command -v node >/dev/null || die 'node is not installed'

git rev-parse --git-dir >/dev/null 2>&1 \
  || die 'not a git repository — see the "First-time setup" section of the README'

git remote get-url origin >/dev/null 2>&1 \
  || die 'no "origin" remote — see the "First-time setup" section of the README'

gh auth status >/dev/null 2>&1 \
  || die 'gh is not authenticated — run: gh auth login'

[[ -z "$(git status --porcelain)" ]] \
  || die 'working tree is dirty — commit or stash first'

DEFAULT_BRANCH="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || echo main)"
CURRENT_BRANCH="$(git symbolic-ref --short HEAD)"
[[ "$CURRENT_BRANCH" == "$DEFAULT_BRANCH" ]] \
  || die "on branch '$CURRENT_BRANCH', expected '$DEFAULT_BRANCH'"

git fetch --quiet origin "$DEFAULT_BRANCH"
[[ -z "$(git rev-list "HEAD..origin/$DEFAULT_BRANCH")" ]] \
  || die "origin/$DEFAULT_BRANCH has commits you do not — pull first"

# ── work out the new version ─────────────────────────────────────────────────
CURRENT="$(node -p 'require("./package.json").version')"
VERSION="$(node -e '
  const [cur, kind] = process.argv.slice(1);
  if (/^\d+\.\d+\.\d+$/.test(kind)) { console.log(kind); process.exit(0); }
  const [a, b, c] = cur.split(".").map(Number);
  const next = { major: [a + 1, 0, 0], minor: [a, b + 1, 0], patch: [a, b, c + 1] }[kind];
  if (!next) { console.error(`not a bump or a version: ${kind}`); process.exit(1); }
  console.log(next.join("."));
' "$CURRENT" "$BUMP")"

TAG="v$VERSION"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "tag $TAG already exists locally"
fi
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  die "tag $TAG already exists on origin"
fi

step "Releasing $CURRENT -> $VERSION (tag $TAG)"

# ── verify ───────────────────────────────────────────────────────────────────
if (( VERIFY )); then
  step 'Running typecheck and tests'
  run npm run typecheck
  run npm test
else
  step 'Skipping local verification (--no-verify)'
fi

# ── bump ─────────────────────────────────────────────────────────────────────
step 'Bumping workspace versions'
for manifest in package.json server/package.json web/package.json; do
  [[ -f "$manifest" ]] || continue
  if (( DRY_RUN )); then
    printf '   would set version in %s to %s\n' "$manifest" "$VERSION"
  else
    node -e '
      const fs = require("fs");
      const [file, version] = process.argv.slice(1);
      const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
      pkg.version = version;
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    ' "$manifest" "$VERSION"
  fi
done

run npm install --package-lock-only --silent

# ── commit, tag, push ────────────────────────────────────────────────────────
step 'Committing and tagging'
run git add package.json package-lock.json server/package.json web/package.json
run git commit -m "release: $TAG"
run git tag -a "$TAG" -m "$TAG"

step 'Pushing to origin'
run git push origin "$DEFAULT_BRANCH"
run git push origin "$TAG"

if (( DRY_RUN )); then
  printf '\n\033[33mdry run — nothing was changed.\033[0m\n'
  exit 0
fi

# ── watch CI ─────────────────────────────────────────────────────────────────
step 'Waiting for the release workflow'

# Match on the tag — for a tag push GitHub reports it as the run's headBranch.
# Taking "the newest run" instead would latch onto the *previous* release before
# this one registers, and report its success as ours.
RUN_ID=''
for _ in $(seq 30); do
  RUN_ID="$(gh run list --workflow=release.yml --branch "$TAG" \
    --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [[ -n "$RUN_ID" ]] && break
  sleep 2
done
[[ -n "$RUN_ID" ]] || die "no release run appeared for $TAG after 60s — check: gh run list"

if ! gh run watch --exit-status "$RUN_ID"; then
  die "the release workflow failed — see: gh run view --log-failed
the tag $TAG is already pushed; fix the problem and re-run with the same version,
after deleting it: git push --delete origin $TAG && git tag -d $TAG"
fi

cat <<EOF

$(printf '\033[32m✓\033[0m') Released $TAG

  Image     $IMAGE:$TAG
            $IMAGE:latest
  Release   $(gh release view "$TAG" --json url --jq .url)

On Unraid: Docker tab -> Fling -> Force update.
EOF

if command -v docker >/dev/null && ! docker manifest inspect "$IMAGE:latest" >/dev/null 2>&1; then
  cat <<'EOF'

⚠ Could not read the image anonymously, so Unraid cannot pull it either.
  GHCR packages are private by default and do NOT inherit the repository's
  visibility. Fix it once:

    github.com -> your profile -> Packages -> fling -> Package settings
    -> Change visibility -> Public

EOF
fi
