#!/usr/bin/env bash
# Publish docs/wiki/ to the GitHub wiki (<repo>.wiki.git).
#
#   scripts/publish-wiki.sh            # clone the wiki, sync, commit, push
#   scripts/publish-wiki.sh --dry-run  # write the converted pages to target/wiki-preview/ and stop
#
# docs/wiki is the source of truth: pages link to each other as `Page.md` and to the repo with
# relative paths, so they render when browsing the repo. Here those links are rewritten for the
# wiki: `Page.md#x` → `Page#x`, images → raw URLs, other repo files → blob URLs on main.
#
# GitHub creates the wiki repository only after the first page is saved in the web UI
# (Wiki tab → "Create the first page" → Save). Run this after that.
set -euo pipefail

root=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
remote=$(git -C "$root" remote get-url origin)
slug=$(sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##' <<<"$remote")
wiki_remote="${remote%.git}.wiki.git"
if [[ "${1:-}" == --dry-run ]]; then
  out="$root/target/wiki-preview"
  mkdir -p "$out"
  find "$out" -maxdepth 1 -name '*.md' -delete
else
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  git clone -q "$wiki_remote" "$work/wiki" || {
    echo "Can't clone $wiki_remote. Enable the wiki and save a first page on GitHub, then retry." >&2
    exit 1
  }
  out="$work/wiki"
  find "$out" -maxdepth 1 -name '*.md' -delete
fi

python3 - "$root/docs/wiki" "$out" "$slug" <<'PY'
import posixpath, re, sys
from pathlib import Path

src, out, slug = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
pages = {p.stem for p in src.glob("*.md")}
blob = f"https://github.com/{slug}/blob/main/"
raw = f"https://github.com/{slug}/raw/main/"
IMAGE = re.compile(r"\.(png|jpe?g|gif|svg|webp)$", re.I)

def convert(target: str) -> str:
    if re.match(r"^[a-z]+:|^#|^/", target):
        return target
    path, _, frag = target.partition("#")
    if "/" not in path and path.endswith(".md") and path[:-3] in pages:
        return path[:-3] + (f"#{frag}" if frag else "")
    repo_path = posixpath.normpath(posixpath.join("docs/wiki", path))
    if repo_path.startswith(".."):
        return target
    base = raw if IMAGE.search(repo_path) else blob
    return base + repo_path + (f"#{frag}" if frag else "")

for p in sorted(src.glob("*.md")):
    text = p.read_text()
    text = re.sub(r"(\]\()([^)\s]+)(\))", lambda m: m[1] + convert(m[2]) + m[3], text)
    text = re.sub(r'(src=")([^"]+)(")', lambda m: m[1] + convert(m[2]) + m[3], text)
    (out / p.name).write_text(text)
print(f"converted {len(pages)} pages")
PY

if [[ "${1:-}" == --dry-run ]]; then
  echo "dry run: pages in $out"
  exit 0
fi

cd "$out"
git add -A
if git diff --cached --quiet; then
  echo "wiki already up to date"
  exit 0
fi
git commit -q -m "docs: sync wiki from $(git -C "$root" rev-parse --short HEAD)"
git push -q origin HEAD
echo "published: https://github.com/$slug/wiki"
