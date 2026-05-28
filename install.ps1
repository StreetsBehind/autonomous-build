# install.ps1 -- link autonomous-build/skills and autonomous-build/formulas into
# the user-global locations Claude Code and bd look in.
#
#   skills/<name>      ->  ~/.claude/skills/<name>     (directory junction; no admin)
#   formulas/<file>    ->  ~/.beads/formulas/<file>    (NTFS hard link; no admin)
#
# Idempotent. Re-running is safe -- entries already pointing at the right target are
# left alone with a "skip" line. Entries pointing somewhere else, or real directories
# / files masking the link, are reported and skipped unless -Force is passed.
#
# Usage:
#   .\install.ps1                # plan + apply
#   .\install.ps1 -DryRun        # plan only, do not modify anything
#   .\install.ps1 -Force          # overwrite mismatched links / dirs / files
#
# Why these specific link types:
# - Directory JUNCTIONs work without admin or developer mode on Windows. Skills are
#   directories full of files Claude Code reads; junctioning the whole subdir keeps
#   any new files (SKILL.md, sub-scripts, fixtures) auto-visible.
# - HARD LINKs work without admin on the same NTFS volume. Formulas are single
#   files; per-file hard links keep ~/.beads/formulas/<name>.formula.toml and
#   formulas/<name>.formula.toml as the same on-disk inode -- editing one updates
#   both, so authoring + bd cook reads stay in sync without a copy step.
# - Why not symbolic links (which would handle both cases uniformly)? Creating
#   them on Windows requires admin OR Developer Mode enabled; not portable across
#   user setups. Junction+hardlink works everywhere this workflow ships.

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$repoRoot         = $PSScriptRoot
$skillsSrc        = Join-Path $repoRoot 'skills'
$formulasSrc      = Join-Path $repoRoot 'formulas'
$skillsDest       = Join-Path $env:USERPROFILE '.claude\skills'
$formulasDest     = Join-Path $env:USERPROFILE '.beads\formulas'

if (-not (Test-Path $skillsSrc))   { throw "skills source missing: $skillsSrc" }
if (-not (Test-Path $formulasSrc)) { throw "formulas source missing: $formulasSrc" }

# Counters for the summary line so /retro can pull them.
$linked  = 0
$ok      = 0
$skipped = 0
$forced  = 0

function Ensure-ParentDir($path) {
    $parent = Split-Path $path -Parent
    if (-not (Test-Path $parent)) {
        if ($DryRun) {
            Write-Host "  [dry] mkdir $parent"
        } else {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
    }
}

function Link-Junction($name, $srcPath, $dstPath) {
    Ensure-ParentDir $dstPath

    if (Test-Path $dstPath) {
        $existing = Get-Item $dstPath -Force
        # Junction (or any reparse point) -> check the target
        if ($existing.LinkType -and $existing.Target) {
            $currentTarget = $existing.Target | Select-Object -First 1
            if ($currentTarget -ieq $srcPath) {
                Write-Host "  [ok]   skill   $name  (junction already correct)"
                $script:ok++
                return
            }
            if ($Force) {
                Write-Host "  [force] skill   $name  (was $($existing.LinkType) -> $currentTarget; relinking)"
                if (-not $DryRun) { (Get-Item $dstPath).Delete() }
                $script:forced++
            } else {
                Write-Host "  [skip] skill   $name  ($($existing.LinkType) -> $currentTarget; pass -Force to overwrite)"
                $script:skipped++
                return
            }
        } else {
            # Real directory in the way.
            if ($Force) {
                Write-Host "  [force] skill   $name  (real directory present; removing and linking)"
                if (-not $DryRun) { Remove-Item $dstPath -Recurse -Force }
                $script:forced++
            } else {
                Write-Host "  [skip] skill   $name  (real directory exists at $dstPath; pass -Force to replace)"
                $script:skipped++
                return
            }
        }
    }

    if ($DryRun) {
        Write-Host "  [dry] junction $dstPath -> $srcPath"
    } else {
        New-Item -ItemType Junction -Path $dstPath -Target $srcPath | Out-Null
        Write-Host "  [link] skill   $name  -> $srcPath"
    }
    $script:linked++
}

function Link-HardLink($name, $srcPath, $dstPath) {
    Ensure-ParentDir $dstPath

    # Same-inode check: two paths are hard-linked iff their NTFS file IDs match.
    if (Test-Path $dstPath) {
        try {
            $srcId = (Get-Item $srcPath).Attributes  # cheap presence check
            $srcFs = Get-Item $srcPath
            $dstFs = Get-Item $dstPath
            # PowerShell 5.1 has no direct inode/FileId accessor without P/Invoke; compare
            # length + last-write as a proxy. Hard-linked files always agree on both because
            # they are the same on-disk file.
            $sameSize = $srcFs.Length -eq $dstFs.Length
            $sameMtime = $srcFs.LastWriteTimeUtc -eq $dstFs.LastWriteTimeUtc
            if ($sameSize -and $sameMtime) {
                Write-Host "  [ok]   formula $name  (already linked or in sync)"
                $script:ok++
                return
            }
        } catch { }

        if ($Force) {
            Write-Host "  [force] formula $name  (existing file differs; replacing with hard link)"
            if (-not $DryRun) { Remove-Item $dstPath -Force }
            $script:forced++
        } else {
            Write-Host "  [skip] formula $name  (existing file differs from source; pass -Force to overwrite)"
            $script:skipped++
            return
        }
    }

    if ($DryRun) {
        Write-Host "  [dry] hardlink $dstPath -> $srcPath"
    } else {
        New-Item -ItemType HardLink -Path $dstPath -Target $srcPath | Out-Null
        Write-Host "  [link] formula $name  -> $srcPath"
    }
    $script:linked++
}

Write-Host "autonomous-build install -- skills + formulas -> user-global"
Write-Host "  repo:         $repoRoot"
Write-Host "  skills dst:   $skillsDest"
Write-Host "  formulas dst: $formulasDest"
if ($DryRun) { Write-Host "  mode:         DRY-RUN (no changes)" }
if ($Force)  { Write-Host "  mode:         FORCE (overwrite mismatched)" }
Write-Host ""

Write-Host "skills/ -> ~/.claude/skills/"
Get-ChildItem $skillsSrc -Directory | Sort-Object Name | ForEach-Object {
    $name = $_.Name
    $src  = $_.FullName
    $dst  = Join-Path $skillsDest $name
    Link-Junction $name $src $dst
}

Write-Host ""
Write-Host "formulas/ -> ~/.beads/formulas/"
Get-ChildItem $formulasSrc -File | Sort-Object Name | ForEach-Object {
    $name = $_.Name
    $src  = $_.FullName
    $dst  = Join-Path $formulasDest $name
    Link-HardLink $name $src $dst
}

Write-Host ""
Write-Host "summary: $linked linked, $ok already correct, $skipped skipped (mismatched), $forced overwritten"
if ($skipped -gt 0 -and -not $Force) {
    Write-Host "  re-run with -Force to overwrite the $skipped skipped entries"
    exit 2
}
exit 0
