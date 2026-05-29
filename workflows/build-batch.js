export const meta = {
  name: 'build-batch',
  description: 'Run N concurrent build-next-style workers in parallel — dispatch beads-builder subagents in their own worktrees, then serialize merges to main behind a post-merge gate. Refuses meta mode (autonomous-build self-edits).',
  whenToUse: 'After /decompose blesses a DAG and the human is ready to fan out builders. Runs in an app repo with at least one ready non-epic bead. Use /loop /build-next for meta-mode work.',
  phases: [
    { title: 'Meta-guard',       detail: 'Refuse if invoked inside autonomous-build (parallel writers would race the shared checkout)' },
    { title: 'Pre-flight',       detail: 'bd healthy, main clean, ready non-epic beads exist' },
    { title: 'Dispatch + drain', detail: 'Wave-dispatch up to --workers builders in parallel, then serialized merge of completions, then refresh and repeat' },
    { title: 'Summary',          detail: 'Structured BATCH COMPLETE; auto-invoke /escalate on blocked, /retro on full drain' }
  ]
};

// ---------------------------------------------------------------------------
// Args
// Match decompose.js's convention for runtime arg discovery. If the runtime
// uses a different name, the smoke test (autonomous-build-mvh.2.3) catches it
// and the fix is a one-line change here.
// ---------------------------------------------------------------------------
const rawArgs =
  (typeof args !== 'undefined') ? args :
  (typeof userArgs !== 'undefined') ? userArgs :
  (typeof input !== 'undefined') ? input : '';

const parsedArgs = parseArgs(rawArgs);
log(`build-batch args: ${JSON.stringify(parsedArgs)}`);

function parseArgs(s) {
  const out = { workers: 2, maxMerges: null, budget: null };
  if (!s) return out;
  const tokens = (typeof s === 'string') ? s.trim().split(/\s+/).filter(Boolean) : (Array.isArray(s) ? s : []);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--workers' && tokens[i + 1]) { out.workers = Math.max(1, parseInt(tokens[++i], 10) || 2); }
    else if (tokens[i] === '--max-merges' && tokens[i + 1]) { out.maxMerges = parseInt(tokens[++i], 10) || null; }
    else if (tokens[i] === '--budget' && tokens[i + 1]) { out.budget = parseFloat(tokens[++i]); }
  }
  if (out.workers > 4) log(`[WARN] --workers=${out.workers} (>4) — merge throughput will dominate; consider lowering`);
  return out;
}

const batchStart = Date.now();

// ---------------------------------------------------------------------------
// Phase 0 — Meta-mode guard (sequential, 1 agent, first check always)
// Hard refuse if running inside autonomous-build. Parallel writers would race
// on the shared checkout; meta mode is /loop /build-next's job.
// ---------------------------------------------------------------------------
phase('Meta-guard');

const metaGuardSchema = {
  type: 'object',
  required: ['isMeta'],
  properties: {
    isMeta: { type: 'boolean' },
    message: { type: 'string' }
  }
};

const guard = await agent(`
You are the meta-guard agent for /build-batch. Spec: workflows/build-batch.spec.md §"Phase 0 — Meta-mode guard".

Check whether \`skills/build-next/SKILL.md\` exists relative to cwd. The marker is build-next's own source file — present by definition in the autonomous-build workflow repo, absent in any app the loop builds. (Do NOT use AGENTS.md — every app has one too.)

Return JSON:
- If the marker exists: { "isMeta": true, "message": "MODE: meta — refusing to fan out. Parallel writes to autonomous-build's own files would race on a shared checkout. Use: /loop /build-next" }
- Otherwise:           { "isMeta": false }

Use Bash or Glob — single Test-Path / ls is enough.
`, { label: 'meta-guard', phase: 'Meta-guard', schema: metaGuardSchema, agentType: 'general-purpose' });

if (guard?.isMeta) {
  log(guard.message);
  return {
    refused: true,
    reason: 'meta-mode',
    message: guard.message,
    merged: [],
    blocked: [],
    failed: []
  };
}
log('Meta-guard PASS — app mode confirmed');

// ---------------------------------------------------------------------------
// Phase 1 — Pre-flight (sequential, 1 agent)
// ---------------------------------------------------------------------------
phase('Pre-flight');

const preflightSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status:        { enum: ['ok', 'done-no-work', 'blocked-only', 'failed'] },
    failedReason:  { type: 'string' },
    readyCount:    { type: 'number' },
    blockedCount:  { type: 'number' }
  }
};

const preflight = await agent(`
You are the pre-flight agent for /build-batch. Spec: workflows/build-batch.spec.md §"Phase 1 — Pre-flight".

Run these checks IN ORDER and return JSON matching the schema:

1. \`bd ready --json\` must succeed. On a JSONL lock error, run \`bd doctor --fix\` once and retry. If still failing, return { "status": "failed", "failedReason": "bd unhealthy: <underlying error>" }.
2. Parse the result, filter out epics (issue_type == "epic"). Set readyCount = filtered length.
3. If readyCount == 0:
   - \`bd blocked --json\`. If non-empty → return { "status": "blocked-only", "readyCount": 0, "blockedCount": N } — caller will invoke /escalate.
   - Else → return { "status": "done-no-work", "readyCount": 0, "blockedCount": 0 }.
4. \`git status --porcelain\` on main must be empty. If dirty, return { "status": "failed", "failedReason": "main has uncommitted state — workers branch from main and would inherit it. Commit, stash, or revert first." }.
5. If all pass: return { "status": "ok", "readyCount": <n>, "blockedCount": 0 }.

Use Bash. Be thorough — failures stop the whole workflow (T1, T7).
`, { label: 'preflight', phase: 'Pre-flight', schema: preflightSchema, agentType: 'general-purpose' });

if (!preflight || preflight.status === 'failed') {
  return {
    refused: false,
    aborted: true,
    reason: preflight?.failedReason || 'preflight returned null',
    merged: [],
    blocked: [],
    failed: []
  };
}

if (preflight.status === 'done-no-work') {
  log('Pre-flight: no ready or blocked work — DONE');
  return { refused: false, drained: true, postAction: 'retro-suggested', merged: [], blocked: [], failed: [] };
}

if (preflight.status === 'blocked-only') {
  log(`Pre-flight: ${preflight.blockedCount} blocked, 0 ready — invoking /escalate`);
  return { refused: false, drained: false, postAction: 'escalate', blockedCount: preflight.blockedCount, merged: [], blocked: [], failed: [] };
}

log(`[BATCH START] workers=${parsedArgs.workers} max-merges=${parsedArgs.maxMerges || 'unbounded'} budget=${parsedArgs.budget != null ? '$' + parsedArgs.budget : 'unbounded'} ready=${preflight.readyCount}`);

// ---------------------------------------------------------------------------
// Phase 2 — Dispatch + drain (wave-loop)
//
// Implementation note (v1): the spec describes a continuous poll loop with
// stat() on marker files. The dynamic-workflow runtime does not expose
// background-task primitives, so v1 uses wave-dispatch: pick up to `workers`
// candidates, parallel() them, await all, then serialized merge of the wave's
// ready-to-merge results, then refresh and repeat. This preserves every
// load-bearing guarantee — up to N concurrent workers, serialized merger,
// filesTouched conflict filter, post-merge gate, blocking on errors. The
// only loss vs the spec's poll-loop is "next wave can't start until the
// slowest builder in the current wave finishes." Smoke test (B3) confirms
// this is acceptable for v1.
// ---------------------------------------------------------------------------
phase('Dispatch + drain');

const mergedSet = [];
const blockedSet = [];
const failedSet = [];
let drainOnly = false;
let waveNum = 0;

// ---------------------------------------------------------------------------
// Budget accounting for --budget (USD cap) — the one financial safety stop for
// an unattended run. Checked before each new wave's dispatch (never mid-worker,
// per spec). The script has no precise per-call billing feed, so cost is an
// ESTIMATE and logged as such:
//   - Preferred: the runtime `budget` global exposes cumulative output-token
//     spend (budget.spent()); convert to USD via a documented rate.
//   - Fallback (no token feed): workers dispatched so far × a per-worker
//     estimate. An approximate bound still beats no bound on a 2-day run.
// Tune the two constants to the model/pricing in use.
// ---------------------------------------------------------------------------
const USD_PER_1M_OUTPUT_TOKENS = 15;    // approximate output-token price
const USD_PER_WORKER_ESTIMATE  = 0.75;  // rough per-bead build cost (fallback)
let workersDispatched = 0;

function estimatedSpendUSD() {
  if (typeof budget !== 'undefined' && budget && typeof budget.spent === 'function') {
    return (budget.spent() / 1_000_000) * USD_PER_1M_OUTPUT_TOKENS;
  }
  return workersDispatched * USD_PER_WORKER_ESTIMATE;
}

// True once estimated cumulative cost has reached the cap. Unbounded if no
// --budget was passed.
function budgetReached() {
  if (parsedArgs.budget == null) return false;
  const spent = estimatedSpendUSD();
  if (spent >= parsedArgs.budget) {
    log(`[BUDGET] estimated cumulative cost ~$${spent.toFixed(2)} >= --budget $${parsedArgs.budget} — no new dispatches; finishing in-flight work and exiting`);
    return true;
  }
  return false;
}

const candidateSchema = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title'],
        properties: {
          id:           { type: 'string' },
          title:        { type: 'string' },
          labels:       { type: 'array' },
          filesTouched: { type: 'array' }
        }
      }
    },
    deferred: { type: 'array' }
  }
};

const prepSchema = {
  type: 'object',
  required: ['prepped', 'failed'],
  properties: {
    prepped: {
      type: 'array',
      items: {
        type: 'object',
        required: ['beadId', 'worktreePath', 'branch'],
        properties: {
          beadId:       { type: 'string' },
          worktreePath: { type: 'string' },
          branch:       { type: 'string' }
        }
      }
    },
    failed: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          beadId: { type: 'string' },
          reason: { type: 'string' }
        }
      }
    }
  }
};

const buildResultSchema = {
  type: 'object',
  required: ['status', 'beadId'],
  properties: {
    status:    { enum: ['ready-to-merge', 'blocked', 'failed'] },
    beadId:    { type: 'string' },
    commitSha: { type: 'string' },
    notes:     { type: 'string' }
  }
};

const mergeResultSchema = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok:     { type: 'boolean' },
    reason: { type: 'string' }
  }
};

while (true) {
  waveNum++;

  // ── Step 1: pick candidates ────────────────────────────────────────────
  // Exclude already-processed beads. Within the wave, apply pairwise
  // filesTouched disjointness — two workers can't safely touch the same files
  // even before the merge step.
  if (drainOnly) {
    log(`[WAVE ${waveNum}] drain-only mode — skipping new dispatches`);
    break;
  }

  // Financial safety stop: if the estimated cumulative cost has reached
  // --budget, dispatch no new work. Each wave merges what it dispatched within
  // the same iteration, so there is no cross-wave in-flight work to drain.
  if (budgetReached()) {
    drainOnly = true;
    break;
  }

  const exclude = [...mergedSet, ...blockedSet, ...failedSet];

  const candResult = await agent(`
You are the candidate-picker for /build-batch wave ${waveNum}. Spec: workflows/build-batch.spec.md §"Phase 2.1 — Poll loop body" (Step A — Fill free slots) and §"Phase 2.3 — Test-FilesTouched-Intersect helper".

Steps:
1. Run \`bd ready --json\`. Filter out epics (issue_type == "epic") and any bead whose id is in the exclude list: ${JSON.stringify(exclude)}.
2. From the remaining beads, select up to ${parsedArgs.workers} candidates, enforcing pairwise filesTouched disjointness within the wave:
   - For each bead, read \`metadata.filesTouched\` (may be undefined or empty).
   - Sort by priority ascending (lower number = higher priority), then by created_at ascending.
   - Greedily accept beads whose filesTouched does NOT intersect any already-accepted bead's filesTouched.
   - Two globs "intersect" if any concrete path matches both: use string-equality OR PowerShell-style \`-like\` glob match in either direction (cheap, slight over-defer is acceptable; false negatives are merge conflicts).
   - Beads with no filesTouched declared fall through (no intersection possible). Note them in "deferred" with reason "no filesTouched — relying on post-merge gate" so the orchestrator can log a warning.
3. Return JSON:
{
  "candidates": [{ "id": "...", "title": "...", "labels": [...], "filesTouched": [...] }, ...],
  "deferred":   [{ "id": "...", "reason": "..." }, ...]
}

Use Bash + the bd CLI. Return at most ${parsedArgs.workers} candidates. If no beads qualify, return { "candidates": [], "deferred": [] }.
`, { label: `wave${waveNum}-candidates`, phase: 'Dispatch + drain', schema: candidateSchema, agentType: 'general-purpose' });

  const candidates = candResult?.candidates || [];
  for (const d of (candResult?.deferred || [])) {
    log(`[SKIP] wave ${waveNum}: ${d.id} deferred — ${d.reason}`);
  }

  if (candidates.length === 0) {
    log(`[WAVE ${waveNum}] no eligible candidates — checking exit conditions`);
    // Refresh: maybe a prior wave unblocked something but it's already excluded;
    // if exclude is the entire ready set, we're done.
    break;
  }

  log(`[WAVE ${waveNum}] dispatching ${candidates.length} builder(s): ${candidates.map(c => c.id).join(', ')}`);

  // ── Step 2: prep (claim + worktree create), serialized ──────────────────
  // Orchestrator-owned per the spec — workers do not claim or create their
  // worktree. One agent does all preps to keep bd writes serialized.
  const labelEscalations = candidates.filter(c =>
    (c.labels || []).includes('needs-decision') || (c.labels || []).includes('touches-auth'));

  for (const c of labelEscalations) {
    log(`[ESCALATE-LABEL] ${c.id} — labels: ${(c.labels || []).join(', ')}`);
  }

  const prepCandidates = candidates.filter(c => !labelEscalations.includes(c));

  if (labelEscalations.length > 0) {
    // Block them all at once via one agent call to keep bd writes serialized.
    await agent(`
For each bead in ${JSON.stringify(labelEscalations.map(c => ({ id: c.id, labels: c.labels })))}:
Run: bd update <id> --status=blocked --notes "label-based escalation: <labels joined>"
Return JSON: { "blocked": [<beadId>, ...] }
`, { label: `wave${waveNum}-escalate-labels`, phase: 'Dispatch + drain', agentType: 'general-purpose' });
    blockedSet.push(...labelEscalations.map(c => c.id));
  }

  if (prepCandidates.length === 0) {
    log(`[WAVE ${waveNum}] all candidates label-escalated — continuing to next wave`);
    continue;
  }

  const prep = await agent(`
You are the prep agent for /build-batch wave ${waveNum}. Spec: workflows/build-batch.spec.md §"Phase 2.2 — Dispatch-Bead helper" (claim + worktree creation portion only — worker dispatch is handled by the orchestrator).

For each bead in ${JSON.stringify(prepCandidates.map(c => ({ id: c.id })))}:
1. \`bd update <id> --claim\`. If exit≠0, the bead was raced — push into "failed" with reason "claim failed (raced)" and skip the rest for this bead.
2. \`bd worktree create "task-<id>" --json\` → capture path. If it errors:
   - \`bd update <id> --status=blocked --notes "worktree create failed"\`
   - push into "failed" with reason "worktree create failed" and skip.
3. On success, push into "prepped": { "beadId": "<id>", "worktreePath": "<path>", "branch": "bead/<id>" }.

Run these serialized (one bead at a time) — concurrent bd writes can race on the jsonl. Return JSON:
{
  "prepped": [{ "beadId": "...", "worktreePath": "...", "branch": "..." }, ...],
  "failed":  [{ "beadId": "...", "reason": "..." }, ...]
}
`, { label: `wave${waveNum}-prep`, phase: 'Dispatch + drain', schema: prepSchema, agentType: 'general-purpose' });

  const prepped = prep?.prepped || [];
  for (const f of (prep?.failed || [])) {
    log(`[PREP-FAIL] ${f.beadId} — ${f.reason}`);
    if (f.reason && f.reason.includes('worktree create failed')) blockedSet.push(f.beadId);
    else failedSet.push(f.beadId);
  }

  if (prepped.length === 0) {
    log(`[WAVE ${waveNum}] no beads prepped — continuing`);
    continue;
  }

  // ── Step 3: dispatch builders in parallel ──────────────────────────────
  // Each thunk spawns a beads-builder subagent against the prepped worktree.
  // The beads-builder returns its BUILD_COMPLETE marker payload as structured
  // output. The .bd-build-complete.json file is a defensive fallback for
  // runtimes where structured output is lossy; we read the file IF the
  // structured return is missing.
  workersDispatched += prepped.length;  // for the fallback cost estimate
  const buildTasks = prepped.map(p => () => agent(`
beadId: ${p.beadId}
worktree: ${p.worktreePath}

You are a beads-builder worker. Your full contract is the beads-builder agent definition; these safeguards are inlined so they bind even if that definition did not load:
- The bead is ALREADY claimed and the worktree is ALREADY created. Do NOT re-claim, do NOT re-create.
- Work inside ${p.worktreePath}. The branch is ${p.branch}.
- ESCALATION PRE-CHECK (before writing code): read docs/ESCALATION_RULES.md in the worktree and block (set status "blocked", \`bd update ${p.beadId} --status=blocked --notes "<reason>"\`, exit) if the bead touches any hard-stop: schema migration on a populated table, an auth/authz model decision, a new paid third-party API, secrets handling, public-facing copy/branding, acceptance you cannot self-verify, or a bead that already failed the gate twice. Do NOT work around an escalation rule.
- Do NOT edit the bead's acceptance criteria to make a failing build pass. Acceptance is the contract; if it's wrong, that's a block, not an edit.
- TESTS: if \`metadata.testPlanFile\` is set on the bead, EXTEND that file — do not create a new singleton test file for this bead. A detected stack with no runnable test suite is a hard fail at the gate, not a pass.
- Stay inside the kickoff's ownership boundaries (if Jankurai is configured); do not edit forbidden paths or files outside the bead's scope (that's a "scope creep" block).
- Implement the bead per its acceptance criteria. Honor the kickoff if Jankurai is configured; if not, proceed.
- Run the quality gate (resolve cross-platform: prefer \`<repo-root>/hooks/post-build-gate.{sh,ps1}\`, else the sibling \`../autonomous-build/hooks/\`; run \`post-build-gate.sh\` on Linux/macOS, \`pwsh -NoProfile -File post-build-gate.ps1\` on Windows). On red, retry once; on second red, block.
- Commit with explicit \`git add\` (no \`-A\`). Commit message: "<bead title> (bd: <beadId>)".
- Do NOT merge to main, do NOT close the bead — the orchestrator owns those steps.
- Write \`<worktree>/.bd-build-complete.json\` AND return the same payload as structured output.

Return JSON exactly matching the marker schema:
{
  "status":    "ready-to-merge" | "blocked" | "failed",
  "beadId":    "${p.beadId}",
  "commitSha": "<sha>"  // only if ready-to-merge
  "notes":     "<one-line summary or failure reason>"
}
`, { label: `build-${p.beadId}`, phase: 'Dispatch + drain', schema: buildResultSchema, agentType: 'beads-builder' }));

  const buildResults = await parallel(buildTasks);

  // ── Step 4: process build results — serialized merges ──────────────────
  // For-loop guarantees at most one merge in flight at any moment (T2 — gate
  // is the contract; serialized merge prevents merge-time races).
  for (let i = 0; i < buildResults.length; i++) {
    const p = prepped[i];
    let marker = buildResults[i];

    if (!marker || !marker.status) {
      // Defensive fallback: scrape the marker file from the worktree.
      const fallback = await agent(`
The beads-builder for ${p.beadId} returned no structured output. Read \`${p.worktreePath}/.bd-build-complete.json\` and return its parsed JSON, or { "status": "failed", "beadId": "${p.beadId}", "notes": "no marker file and no structured return" } if the file is absent or unparseable.
`, { label: `fallback-marker-${p.beadId}`, phase: 'Dispatch + drain', schema: buildResultSchema, agentType: 'general-purpose' });
      marker = fallback;
    }

    if (!marker || !marker.status) {
      log(`[WORKER] ${p.beadId} returned no marker — treating as failed`);
      failedSet.push(p.beadId);
      continue;
    }

    if (marker.status === 'blocked') {
      log(`[WORKER] ${p.beadId} blocked: ${marker.notes || '(no notes)'}`);
      blockedSet.push(p.beadId);
      await agent(`bd worktree remove "task-${p.beadId}" --force. Return { "ok": true } or { "ok": false, "reason": "..." }.`,
        { label: `cleanup-${p.beadId}`, phase: 'Dispatch + drain', agentType: 'general-purpose' });
      continue;
    }

    if (marker.status === 'failed') {
      log(`[WORKER] ${p.beadId} failed: ${marker.notes || '(no notes)'}`);
      log(`  Worktree left at ${p.worktreePath} for human inspection.`);
      failedSet.push(p.beadId);
      continue;
    }

    if (marker.status === 'ready-to-merge') {
      log(`[WORKER] ${p.beadId} completed (sha ${marker.commitSha || '?'}) → merge`);

      const mergeResult = await agent(`
You are the merge agent for /build-batch, bead=${p.beadId}. Spec: workflows/build-batch.spec.md §"Phase 2.5 — Serialized merge step".

This call is the ONLY merger running right now — the orchestrator awaits it before processing the next ready-to-merge bead. Do NOT spawn parallel git operations.

Steps (all from the repo root: \`git rev-parse --show-toplevel\`):
1. \`git checkout main\`.
2. \`git remote\`. If non-empty list:
   - \`git pull --ff-only origin main\`. If exit≠0:
     - \`bd update ${p.beadId} --status=blocked --notes "git pull --ff-only origin main failed before merge — local main is behind remote and cannot fast-forward"\`.
     - Return { "ok": false, "reason": "pull-failed" }.
3. \`git merge --no-ff ${p.branch} -m "Merge ${p.beadId}"\`. If exit≠0:
   - \`git merge --abort\`.
   - \`bd update ${p.beadId} --status=blocked --notes "merge conflict against main" --append-notes "<merge output>"\`.
   - Return { "ok": false, "reason": "merge-conflict" }.
4. Run the quality gate (resolve cross-platform: prefer \`<repo-root>/hooks/post-build-gate.{sh,ps1}\`, else the sibling \`../autonomous-build/hooks/\`; \`post-build-gate.sh\` on Linux/macOS, \`pwsh -NoProfile -File post-build-gate.ps1\` on Windows). If exit≠0:
   - \`git reset --hard HEAD~1\` (undo the merge — main returns to its pre-merge head).
   - \`bd update ${p.beadId} --status=blocked --notes "post-merge gate failed on main" --append-notes "<gate output>"\`.
   - Return { "ok": false, "reason": "gate-failed" }.
5. \`bd close ${p.beadId}\`.
6. \`bd worktree remove "task-${p.beadId}" --force\`.
7. Return { "ok": true }.

Use Bash. Return JSON: { "ok": <bool>, "reason"?: "<string>" }.
`, { label: `merge-${p.beadId}`, phase: 'Dispatch + drain', schema: mergeResultSchema, agentType: 'general-purpose' });

      if (mergeResult?.ok === true) {
        mergedSet.push(p.beadId);
        log(`[MERGE] ${p.beadId} → main (post-gate PASS)`);
      } else {
        blockedSet.push(p.beadId);
        log(`[MERGE-FAIL] ${p.beadId} — ${mergeResult?.reason || 'unknown'}`);
      }
      continue;
    }

    // Unknown status
    log(`[WORKER] ${p.beadId} returned unknown status "${marker.status}" — treating as failed`);
    failedSet.push(p.beadId);
  }

  // ── Step 5: check exit conditions ──────────────────────────────────────
  if (parsedArgs.maxMerges && mergedSet.length >= parsedArgs.maxMerges) {
    log(`[BATCH] hit --max-merges=${parsedArgs.maxMerges}, draining active pipelines (none) and exiting`);
    drainOnly = true;
    // Wave-dispatch model has no in-flight pipelines outside the wave we just
    // awaited, so "draining" is a no-op — we just stop dispatching.
    break;
  }

  // Failure-rate abort: >50% of attempted beads ended in failedSet (not
  // blocked — failed means truly unexpected). Honor the stopping condition.
  const attempted = mergedSet.length + blockedSet.length + failedSet.length;
  if (attempted > 0 && failedSet.length / attempted > 0.5 && attempted >= 4) {
    log(`[BATCH ABORT] failure rate ${failedSet.length}/${attempted} exceeds 50% — stopping (something systemic is wrong)`);
    break;
  }

  // Loop continues — next wave will pick up newly-ready beads (workers may
  // have unblocked dependents) and skip excluded ones.
}

// ---------------------------------------------------------------------------
// Phase 3 — Summary + post-actions (sequential, 1 agent)
// ---------------------------------------------------------------------------
phase('Summary');

const durationMs = Date.now() - batchStart;
const durationStr = `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`;

log(`[BATCH COMPLETE]`);
log(`  Merged:   ${mergedSet.length} beads → ${mergedSet.join(', ') || '(none)'}`);
log(`  Blocked:  ${blockedSet.length} beads → ${blockedSet.join(', ') || '(none)'}`);
log(`  Failed:   ${failedSet.length} beads → ${failedSet.join(', ') || '(none)'}`);
log(`  Duration: ${durationStr}`);

// Post-action decision: /escalate if blockedSet non-empty; /retro if clean drain.
let postAction = 'none';
const summaryActions = await agent(`
You are the summary agent for /build-batch Phase 3. Spec: workflows/build-batch.spec.md §"Phase 3 — Summary + post-actions".

Inputs:
  merged:  ${JSON.stringify(mergedSet)}
  blocked: ${JSON.stringify(blockedSet)}
  failed:  ${JSON.stringify(failedSet)}

Decide and execute the post-action:
1. If blocked.length > 0:
   - Invoke /escalate by writing a one-line marker the runtime can pick up, OR by running the escalate skill's underlying behavior directly (read bd blocked, format push notification body). For v1, just record postAction="escalate"; do NOT attempt to spawn /escalate as a slash command from within the workflow — the orchestrator turn handles that.
2. Else if failed.length > 0:
   - Print worktree paths via Bash (\`git worktree list\`) so the human can inspect. Record postAction="inspect-failed".
3. Else:
   - Run \`bd ready --json\` and filter epics. If the remaining list is empty AND merged.length > 0 (we actually did work and nothing else is ready), record postAction="retro-suggested".
   - Otherwise record postAction="none".

Return JSON: { "postAction": "escalate" | "inspect-failed" | "retro-suggested" | "none", "rationale": "<one sentence>" }
`, { label: 'summary', phase: 'Summary', agentType: 'general-purpose' });

if (summaryActions?.postAction) {
  postAction = summaryActions.postAction;
  log(`Post-action: ${postAction} — ${summaryActions.rationale || ''}`);
}

// ---------------------------------------------------------------------------
// Return final result to runtime
// ---------------------------------------------------------------------------
return {
  refused: false,
  drained: blockedSet.length === 0 && failedSet.length === 0,
  postAction,
  merged: mergedSet,
  blocked: blockedSet,
  failed: failedSet,
  waveCount: waveNum,
  durationSec: Math.round(durationMs / 1000)
};
