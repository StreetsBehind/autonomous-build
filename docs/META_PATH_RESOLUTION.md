# Resolving the autonomous-build (meta) repo from inside an app

Several consumers need to find *this* repo while running from a **sibling app repo's**
cwd (e.g. smbuild): `/flag --upstream` files a triage bead here, and `/retro` files
improvement beads here. They must not hardcode a path — the repo lives at different
absolute locations on different hosts (`~/.openclaw/workspace/autonomous-build` here,
`~/Documents/Github/autonomous-build` was the old hardcoded default and **does not exist
on every host** — a no-arg `/retro` against it silently dropped to file-only and filed
zero beads; this doc exists to kill that failure mode).

Resolution bootstraps from `$HOME` only — it must **not** depend on already knowing the
meta path (that is the chicken-and-egg it solves).

## Canonical order

Try each in order; first hit that passes **validation** wins:

1. **Explicit override** — a `--meta-path <path>` arg (retro) if the caller supplied one.
2. **Env var** — `$AUTONOMOUS_BUILD_HOME`, if set.
3. **Installed-link trace** — the installers link this repo into `$HOME`:
   - POSIX (`install.sh`): `~/.claude/skills/*` and `~/.claude/workflows/*.js` are **symlinks** → resolvable with `readlink -f`.
   - Windows (`install.ps1`): `~/.claude/skills/*` are **junctions** (resolvable via `(Get-Item).Target`); `~/.claude/workflows/*.js` are **hardlinks** (NOT resolvable — do not trace these on Windows).
   So trace a **skill** link (portable across both) — `~/.claude/skills/flag` — and walk up two directories (`…/skills/flag` → repo root). On POSIX a workflow symlink (`~/.claude/workflows/retro.js`) works too.
4. **Candidate probe** — first of these that validates: `~/.openclaw/workspace/autonomous-build`, `~/Documents/Github/autonomous-build`.

If none validate: **fail loudly** naming the fix (`set AUTONOMOUS_BUILD_HOME=<path> or pass --meta-path`). Never silently continue as if there were nowhere to file — a silent miss is the bug this doc removes.

## Validation

A candidate is the meta repo iff **both** hold (guards against a stale link or a same-named unrelated dir):

- `<cand>/.beads/` exists (so `bd` can write here), **and**
- `<cand>/skills/build-next/SKILL.md` exists (the same sentinel `/build-next` and `/build-batch` use to detect meta mode — present here, absent in any app the loop builds).

## POSIX reference (bash)

```bash
resolve_meta() {
  local c
  for c in "$AUTONOMOUS_BUILD_HOME" \
           "$(readlink -f ~/.claude/skills/flag 2>/dev/null | xargs -r dirname | xargs -r dirname)" \
           "$(readlink -f ~/.claude/workflows/retro.js 2>/dev/null | xargs -r dirname | xargs -r dirname)" \
           "$HOME/.openclaw/workspace/autonomous-build" \
           "$HOME/Documents/Github/autonomous-build"; do
    [ -n "$c" ] && [ -d "$c/.beads" ] && [ -f "$c/skills/build-next/SKILL.md" ] && { echo "$c"; return 0; }
  done
  echo "ERROR: cannot resolve autonomous-build; set AUTONOMOUS_BUILD_HOME=<path>" >&2
  return 1
}
```

## PowerShell reference (parity)

```powershell
function Resolve-Meta {
  $cands = @(
    $env:AUTONOMOUS_BUILD_HOME,
    (Get-Item ~/.claude/skills/flag -ErrorAction SilentlyContinue).Target | Split-Path | Split-Path,
    "$HOME/.openclaw/workspace/autonomous-build",
    "$HOME/Documents/Github/autonomous-build"
  )
  foreach ($c in $cands) {
    if ($c -and (Test-Path "$c/.beads") -and (Test-Path "$c/skills/build-next/SKILL.md")) { return $c }
  }
  throw "cannot resolve autonomous-build; set AUTONOMOUS_BUILD_HOME=<path>"
}
```

## Consumers (keep in sync when this rule changes)

- `skills/flag/SKILL.md` — `--upstream` mode.
- `workflows/retro.js` + `workflows/retro.spec.md` — Phase 1 pre-flight `metaPath` resolution (default is `null` → resolve via this rule unless `--meta-path` given).
