#!/usr/bin/env bash
# install.sh -- link autonomous-build/skills, autonomous-build/formulas,
# autonomous-build/workflows, and autonomous-build/.claude/agents into the
# user-global locations Claude Code and bd look in. The POSIX counterpart to
# install.ps1 (which is Windows-only).
#
#   skills/<name>        ->  ~/.claude/skills/<name>      (symlink)
#   formulas/<file>      ->  ~/.beads/formulas/<file>     (symlink)
#   workflows/<f>.js     ->  ~/.claude/workflows/<f>.js   (symlink)
#   .claude/agents/<f>.md->  ~/.claude/agents/<f>.md      (symlink)
#
# Agents matter because /build-batch dispatches the `beads-builder` agent by
# name; without the global agent definition, workers silently fall back to a
# generic agent that lacks the escalation pre-check and safety rules.
#
# Workflow .spec.md files are NOT distributed -- they live in the repo for spec
# authoring only. Only the canonical .js scripts ship to the runtime location.
#
# Why symlinks (not hard links / junctions like install.ps1)? On Linux/macOS
# symbolic links work without admin and across the whole tree, so the single
# uniform mechanism that needs admin/Developer-Mode on Windows is the natural
# default here. Editing the repo file updates what the runtime reads, no copy.
#
# Idempotent. Re-running is safe -- a link already pointing at the right target
# is left alone ("[ok]"). A link/file/dir pointing elsewhere is reported and
# skipped unless -f/--force is passed. A small cleanup at the end removes any
# ~/.claude/skills/<name> symlink whose source no longer exists in this repo
# (catches skills that graduated to workflows). Real files/dirs are never
# touched.
#
# Usage:
#   ./install.sh            # plan + apply
#   ./install.sh --dry-run  # plan only, change nothing
#   ./install.sh --force    # replace mismatched links / files / dirs

set -euo pipefail

DRY_RUN=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    -n|--dry-run) DRY_RUN=1 ;;
    -f|--force)   FORCE=1 ;;
    -h|--help)    grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg (try --help)" >&2; exit 64 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"
FORMULAS_SRC="$REPO_ROOT/formulas"
WORKFLOWS_SRC="$REPO_ROOT/workflows"
AGENTS_SRC="$REPO_ROOT/.claude/agents"
SKILLS_DST="$HOME/.claude/skills"
FORMULAS_DST="$HOME/.beads/formulas"
WORKFLOWS_DST="$HOME/.claude/workflows"
AGENTS_DST="$HOME/.claude/agents"

[ -d "$SKILLS_SRC" ]   || { echo "skills source missing: $SKILLS_SRC" >&2; exit 1; }
[ -d "$FORMULAS_SRC" ] || { echo "formulas source missing: $FORMULAS_SRC" >&2; exit 1; }
# workflows/ and .claude/agents/ are optional -- a fresh repo may have neither yet.

linked=0; ok=0; skipped=0; forced=0; cleaned=0

# link <category> <name> <src> <dst>
link() {
  local cat="$1" name="$2" src="$3" dst="$4"
  local tag; printf -v tag '%-8s' "$cat"

  if [ -L "$dst" ]; then
    local cur; cur="$(readlink "$dst")"
    if [ "$cur" = "$src" ]; then
      echo "  [ok]   $tag $name  (already linked)"; ok=$((ok+1)); return
    fi
    if [ "$FORCE" = 1 ]; then
      echo "  [force] $tag $name  (was -> $cur; relinking)"
      [ "$DRY_RUN" = 1 ] || rm -f "$dst"; forced=$((forced+1))
    else
      echo "  [skip] $tag $name  (-> $cur; pass --force to overwrite)"; skipped=$((skipped+1)); return
    fi
  elif [ -e "$dst" ]; then
    if [ "$FORCE" = 1 ]; then
      echo "  [force] $tag $name  (real path present; removing and linking)"
      [ "$DRY_RUN" = 1 ] || rm -rf "$dst"; forced=$((forced+1))
    else
      echo "  [skip] $tag $name  (real file/dir at $dst; pass --force to replace)"; skipped=$((skipped+1)); return
    fi
  fi

  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry] symlink $dst -> $src"
  else
    mkdir -p "$(dirname "$dst")"
    ln -s "$src" "$dst"
    echo "  [link] $tag $name  -> $src"
  fi
  linked=$((linked+1))
}

echo "autonomous-build install -- skills + formulas + workflows -> user-global"
echo "  repo:          $REPO_ROOT"
echo "  skills dst:    $SKILLS_DST"
echo "  formulas dst:  $FORMULAS_DST"
echo "  workflows dst: $WORKFLOWS_DST"
echo "  agents dst:    $AGENTS_DST"
[ "$DRY_RUN" = 1 ] && echo "  mode:          DRY-RUN (no changes)"
[ "$FORCE" = 1 ]   && echo "  mode:          FORCE (overwrite mismatched)"
echo

echo "skills/ -> ~/.claude/skills/"
for d in "$SKILLS_SRC"/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  link skill "$name" "${d%/}" "$SKILLS_DST/$name"
done

echo
echo "formulas/ -> ~/.beads/formulas/"
for f in "$FORMULAS_SRC"/*; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  link formula "$name" "$f" "$FORMULAS_DST/$name"
done

echo
echo "workflows/ -> ~/.claude/workflows/"
if [ -d "$WORKFLOWS_SRC" ]; then
  shopt -s nullglob
  js=("$WORKFLOWS_SRC"/*.js)
  shopt -u nullglob
  if [ "${#js[@]}" -eq 0 ]; then
    echo "  (no .js scripts yet -- spec files in workflows/ are not distributed)"
  else
    for f in "${js[@]}"; do
      name="$(basename "$f")"
      link workflow "$name" "$f" "$WORKFLOWS_DST/$name"
    done
  fi
else
  echo "  (workflows/ directory absent; skipping)"
fi

echo
echo ".claude/agents/ -> ~/.claude/agents/"
if [ -d "$AGENTS_SRC" ]; then
  shopt -s nullglob
  agents=("$AGENTS_SRC"/*.md)
  shopt -u nullglob
  if [ "${#agents[@]}" -eq 0 ]; then
    echo "  (no agent .md files yet)"
  else
    for f in "${agents[@]}"; do
      name="$(basename "$f")"
      link agent "$name" "$f" "$AGENTS_DST/$name"
    done
  fi
else
  echo "  (.claude/agents/ directory absent; skipping)"
fi

echo
echo "stale-skill cleanup (symlinks whose source no longer exists in this repo)"
if [ -d "$SKILLS_DST" ]; then
  for entry in "$SKILLS_DST"/*; do
    [ -L "$entry" ] || continue           # real dir -> leave alone
    target="$(readlink "$entry")"
    case "$target" in
      "$SKILLS_SRC"/*) ;;                  # points into THIS repo's skills/
      *) continue ;;
    esac
    [ -e "$target" ] && continue           # source still exists -> current
    if [ "$DRY_RUN" = 1 ]; then
      echo "  [dry] remove stale skill symlink: $entry -> $target"
    else
      rm -f "$entry"
      echo "  [clean] removed stale skill symlink: $(basename "$entry")"
    fi
    cleaned=$((cleaned+1))
  done
fi
[ "$cleaned" -eq 0 ] && echo "  (none)"

echo
echo "summary: $linked linked, $ok already correct, $skipped skipped (mismatched), $forced overwritten, $cleaned stale links cleaned"
if [ "$skipped" -gt 0 ] && [ "$FORCE" != 1 ]; then
  echo "  re-run with --force to overwrite the $skipped skipped entries"
  exit 2
fi
exit 0
