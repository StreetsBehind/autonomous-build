# Install

One-time setup for the workflow infrastructure, then per-app setup whenever you start a new project.

## Prerequisites

- `bd` (beads) on PATH. Verify: `bd --help`. If missing, see https://github.com/steveyegge/beads (see [Troubleshooting bd install](#troubleshooting-bd-install) below).
- `jankurai` on PATH. Verify: `jankurai version`. Install from source: `git clone https://github.com/neverhuman/jankurai && cd jankurai && cargo install --path crates/jankurai --locked`. Or use the release installer at https://github.com/neverhuman/jankurai/releases. Jankurai is the [quality standard](../README.md#quality-standard) every app this workflow builds is held to — required, not optional.
- Claude Code installed and configured.
- Git.

## One-time: link skills and formulas globally

From this repo's root:

```powershell
# Skills: symlink each into ~/.claude/skills/
$src = (Resolve-Path .\skills).Path
$dst = "$env:USERPROFILE\.claude\skills"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Get-ChildItem $src -Directory | ForEach-Object {
  $linkPath = Join-Path $dst $_.Name
  if (-not (Test-Path $linkPath)) {
    New-Item -ItemType SymbolicLink -Path $linkPath -Target $_.FullName | Out-Null
  }
}

# Formulas: symlink the whole dir into ~/.beads/formulas/
$fSrc = (Resolve-Path .\formulas).Path
$fDst = "$env:USERPROFILE\.beads\formulas"
New-Item -ItemType Directory -Force -Path (Split-Path $fDst) | Out-Null
if (-not (Test-Path $fDst)) {
  New-Item -ItemType SymbolicLink -Path $fDst -Target $fSrc | Out-Null
}
```

> Symlinks on Windows require either Developer Mode enabled (Settings → Privacy & security → For developers) or an elevated PowerShell. If neither is available, fall back to **directory junctions** — they require no privileges, work for the skills (each is a directory) and the formulas folder (one directory), and behave identically for our purposes. The block below tries `SymbolicLink` first and falls back to `mklink /J`:

```powershell
function Try-Link {
  param([string]$linkPath, [string]$targetPath)
  if (Test-Path $linkPath) { return }
  try { New-Item -ItemType SymbolicLink -Path $linkPath -Target $targetPath -ErrorAction Stop | Out-Null }
  catch { cmd /c mklink /J "$linkPath" "$targetPath" | Out-Null }
}
Get-ChildItem .\skills -Directory | ForEach-Object { Try-Link (Join-Path "$env:USERPROFILE\.claude\skills" $_.Name) $_.FullName }
Try-Link "$env:USERPROFILE\.beads\formulas" ((Resolve-Path .\formulas).Path)
```

After installing, **restart Claude Code** so the new skills get discovered. They show up as `/vision`, `/compose`, `/build-next`, `/escalate`.

Verify:

```powershell
bd formula list   # should list app-skeleton, crud-feature, etc. — but only inside a bd-initialized dir
```

## Per-app: bootstrap a new project

```powershell
# Pick a sibling directory
$app = "my-new-app"
New-Item -ItemType Directory -Path "$env:USERPROFILE\Documents\Github\$app" | Out-Null
Set-Location "$env:USERPROFILE\Documents\Github\$app"

git init
bd init
bd setup claude --project   # writes Claude Code hooks for SessionStart and PreCompact
bd hooks install            # auto-sync bd prime at session start
```

Then copy `templates/vision.md` from this repo into the new app as `vision.md`, fill it out, and run `/vision`.

## Verifying the install

In a freshly initialized app repo:

```powershell
bd prime           # should print agent workflow context (not empty)
bd formula list    # should show formulas symlinked from autonomous-build/
jankurai version   # should print CLI + standard + schema versions
```

If `bd formula list` is empty inside a `bd init`'d project, the formula symlink isn't being picked up — check `~/.beads/formulas/` exists and points where you expect.

If `jankurai version` fails, the rest of the pipeline will refuse to run (`/compose` pre-flight check #5). Reinstall before continuing.

## Troubleshooting bd install

The canonical beads module path is **`github.com/steveyegge/beads`**. An older `github.com/gastownhall/beads` URL appears in some docs and links; it is stale and will break a `go install` because the declared module path no longer matches.

Working install line:

```sh
go install github.com/steveyegge/beads/cmd/bd@latest
```

Failure symptoms that mean you used the wrong path:

- `go install`/`go get` fails with a **module-path mismatch** — e.g. `module declares its path as: github.com/steveyegge/beads / but was required as: github.com/gastownhall/beads`.
- `bd: command not found` after a `go install` that appeared to succeed against `gastownhall/beads` (it never produced a `bd` binary).

If you hit either, re-run the install line above with the `steveyegge` path and confirm with `bd --help`.
