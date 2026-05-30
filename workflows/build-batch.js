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
You are the meta-guard agent for /build-batch. (Self-contained — all steps are inline below; you run in the app repo cwd, where the workflow spec is not present, so do NOT try to read workflows/build-batch.spec.md.)

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
    blockedCount:  { type: 'number' },
    decisions:     { type: 'object' }   // { authDecided, secretsDecided, migrationDecided } from plan.lock concerns
  }
};

const preflight = await agent(`
You are the pre-flight agent for /build-batch. (Self-contained — all steps are inline below; you run in the app repo cwd, where the workflow spec is not present, so do NOT try to read workflows/build-batch.spec.md.)

Run these checks IN ORDER and return JSON matching the schema:

1. \`bd ready --json\` must succeed. On a JSONL lock error, run \`bd doctor --fix\` once and retry. If still failing, return { "status": "failed", "failedReason": "bd unhealthy: <underlying error>" }.
2. Parse the result, filter out epics (issue_type == "epic"). Set readyCount = filtered length.
3. If readyCount == 0:
   - \`bd list --status=blocked --json\` (the status field, NOT \`bd blocked\` — that lists only dependency-blocked beads and misses the \`--status=blocked\` ones the loop sets; autonomous-build-gh4). If non-empty → return { "status": "blocked-only", "readyCount": 0, "blockedCount": N } — caller will invoke /escalate.
   - Else → return { "status": "done-no-work", "readyCount": 0, "blockedCount": 0 }.
4. \`git status --porcelain\` on main must be empty. If dirty, return { "status": "failed", "failedReason": "main has uncommitted state — workers branch from main and would inherit it. Commit, stash, or revert first." }.
5. Read \`plan.lock.json\` from cwd if present (it may be absent for a pre-/vision-concerns app). Compute front-loaded decision flags from its \`concerns[]\` array (lbq.3) — these let labeled beads clear unattended because the decision was made at /vision time:
   - decisions.authDecided = a concerns[] entry with concernId "authn" OR "authz" has status == "addressed".
   - decisions.secretsDecided = the "secrets" concern is "addressed".
   - decisions.migrationDecided = the "data-lifecycle" concern is "addressed".
   If plan.lock is absent or has no concerns[], all three are false.
6. If all pass: return { "status": "ok", "readyCount": <n>, "blockedCount": 0, "decisions": { "authDecided": <bool>, "secretsDecided": <bool>, "migrationDecided": <bool> } }.

Use Bash, Read. Be thorough — failures stop the whole workflow (T1, T7).
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

// Front-loaded auth/secrets/migration decisions from plan.lock (lbq.3). When a
// decision was made at /vision time, a bead that merely *touches* that area is
// NOT an escalation — the builder implements the decided model. Without this, a
// login-bearing app blocks every touches-auth bead mid-run and pages an absent
// human. needs-decision stays unconditional.
const decisions = preflight.decisions || { authDecided: false, secretsDecided: false, migrationDecided: false };
log(`[BATCH START] workers=${parsedArgs.workers} max-merges=${parsedArgs.maxMerges || 'unbounded'} budget=${parsedArgs.budget != null ? '$' + parsedArgs.budget : 'unbounded'} ready=${preflight.readyCount} decided={auth:${!!decisions.authDecided},secrets:${!!decisions.secretsDecided},migration:${!!decisions.migrationDecided}}`);

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
// Crash recovery (lbq.7) — over a 2-day window an OOM/restart strands beads
// that are `in_progress` (claimed, worktree on disk) but invisible to
// `bd ready`. State is otherwise in-memory and lost. So: (a) on startup, seed
// the processed sets from the on-disk checkpoint of a prior crashed run and
// reap stale claims; (b) checkpoint after every wave so a restart resumes
// instead of re-doing or stranding work. The checkpoint file is local runtime
// state (gitignored), written via a Bash agent since the script has no fs.
//
// Salvage (execute-2): the merge agent's `bd close` is its LAST step, so a
// crash between `git merge --no-ff` and `bd close` leaves a bead `in_progress`
// whose work is ALREADY on main. Reaping it back to open would rebuild merged
// work from scratch (and a deterministic crash can permanently strand it). So
// before reopening an orphan, the reaper checks whether `bead/<id>` is already
// an ancestor of main; if so it just `bd close`s it. Genuinely unmerged work
// (never passed the post-merge gate) is still discarded and rebuilt.
// ---------------------------------------------------------------------------
const STATE_FILE = '.bd-batch-state.json';
const recoverSchema = {
  type: 'object',
  required: ['merged', 'blocked', 'failed', 'reaped'],
  properties: {
    merged:        { type: 'array', items: { type: 'string' } },
    blocked:       { type: 'array', items: { type: 'string' } },
    failed:        { type: 'array', items: { type: 'string' } },
    reaped:        { type: 'array', items: { type: 'object' } },   // reset orphans { beadId, hadUnmergedWork }
    discardedWork: { type: 'number' },                             // count of orphans whose unmerged commit was discarded
    closedAlreadyMerged: { type: 'array', items: { type: 'string' } } // orphans whose work already landed on main (crash between merge and bd close) — closed, not rebuilt (execute-2)
  }
};
const recovery = await agent(`
You are the crash-recovery / stale-claim reaper for /build-batch (lbq.7). A prior run may have crashed (OOM, restart) mid-batch. Reconcile from the repo root (\`git rev-parse --show-toplevel\`).

1. RESUME STATE: if \`${STATE_FILE}\` exists, read it — it holds { merged: [...], blocked: [...], failed: [...], waveNum, ts } from the last wave of a prior run. Return those arrays so this run does not reprocess them. If absent, all three are [].
2. STALE-CLAIM REAP: run \`bd list --status=in_progress --json\`. **At orchestrator startup nothing has been dispatched yet, so every in_progress bead is necessarily an orphan from a crashed run.** For each, decide salvage-vs-reset:
   a. ALREADY-MERGED SALVAGE (check this BEFORE any reopen): the merge agent's \`bd close\` is its LAST step, so a crash between \`git merge --no-ff\` and \`bd close\` leaves the bead in_progress with its work already on main. If a branch \`bead/<id>\` exists AND \`git merge-base --is-ancestor bead/<id> main\` exits 0 (its tip is reachable from main ⇒ already merged), the work is DONE — do NOT rebuild it: run \`bd close <id>\`, \`bd worktree remove "task-<id>" --force\` if that worktree exists, and \`git branch -D bead/<id>\` (safe — it is merged). Record the id under "closedAlreadyMerged" and skip the rest for this bead.
   b. OTHERWISE reset so it re-dispatches cleanly:
      - \`bd update <id> --status=open\` (un-claim).
      - If a worktree \`task-<id>\` exists: \`bd worktree remove "task-<id>" --force\`.
      - If a stale branch \`bead/<id>\` exists: note whether it had a commit ahead of main (\`git log main..bead/<id> --oneline\` non-empty = unmerged work being discarded), then \`git branch -D bead/<id>\` so the re-dispatch's worktree-create doesn't collide. Rebuilding from scratch is the safe choice — an unmerged worker commit never passed the post-merge gate on main.
      Record under "reaped" ({ beadId, hadUnmergedWork: <bool> }); set discardedWork = count with hadUnmergedWork true.
   Use LOCAL refs only (builds are local-first; no \`git push\`). Run bd/git writes serialized. Do NOT touch closed or blocked beads.
3. Return { "merged": [...], "blocked": [...], "failed": [...], "reaped": [...], "closedAlreadyMerged": [...], "discardedWork": <n> }.
Use Bash. On any error, return empty arrays rather than throwing (T7) — a failed reap must not block a fresh run.
`, { label: 'crash-recovery', phase: 'Dispatch + drain', schema: recoverSchema, agentType: 'general-purpose' });

if (recovery) {
  const resumedMerged = recovery.merged || [];
  // execute-2: orphans whose work already landed on main (crash between merge and
  // bd close) were just closed by the reaper. Count them merged so they aren't
  // re-picked, and surface them distinctly from checkpoint-resumed merges.
  const salvaged = recovery.closedAlreadyMerged || [];
  mergedSet.push(...resumedMerged, ...salvaged);
  blockedSet.push(...(recovery.blocked || []));
  failedSet.push(...(recovery.failed || []));
  const reaped = (recovery.reaped || []).length;
  if (reaped || salvaged.length || mergedSet.length || blockedSet.length || failedSet.length) {
    log(`[RECOVER] resumed ${resumedMerged.length} merged / ${blockedSet.length} blocked / ${failedSet.length} failed from checkpoint; reaped ${reaped} stale claim(s)${salvaged.length ? `, salvaged ${salvaged.length} already-merged orphan(s) (closed, not rebuilt)` : ''}${recovery.discardedWork ? ` (${recovery.discardedWork} had unmerged work discarded — they rebuild)` : ''}`);
  }
}

// Write the checkpoint after a wave so a restart resumes from here. Fire-and-
// await a Bash agent (the script has no fs). Cheap relative to a wave of builds.
async function checkpoint() {
  await agent(`
Write ${STATE_FILE} at the repo root (\`git rev-parse --show-toplevel\`) with exactly this JSON (overwrite): ${JSON.stringify({ merged: mergedSet, blocked: blockedSet, failed: failedSet, waveNum })}. Also ensure ${STATE_FILE} is in .gitignore (append a line if missing) — it is local runtime state, never committed. Return { "ok": true }.
`, { label: `checkpoint-w${waveNum}`, phase: 'Dispatch + drain', agentType: 'general-purpose' });
}

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

// Per-worker stage timeout (spec default 30 min). A worker that hangs without
// emitting BUILD_COMPLETE (wedged on a tool prompt or interactive command) would
// otherwise make parallel() never resolve and stall the whole batch forever.
const STAGE_TIMEOUT_MIN = 30;

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
You are the candidate-picker for /build-batch wave ${waveNum}. (Self-contained — all steps are inline below; you run in the app repo cwd, where the workflow spec is not present, so do NOT try to read workflows/build-batch.spec.md.)

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
  // needs-decision always escalates. touches-auth/secrets/migration escalate
  // ONLY when plan.lock did not front-load that decision (lbq.3) — otherwise the
  // builder implements the decided model and proceeds unattended.
  const labelEscalations = candidates.filter(c => {
    const labels = c.labels || [];
    if (labels.includes('needs-decision')) return true;
    if (labels.includes('touches-auth') && !decisions.authDecided) return true;
    if (labels.includes('touches-secrets') && !decisions.secretsDecided) return true;
    if (labels.includes('touches-migration') && !decisions.migrationDecided) return true;
    return false;
  });

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
You are the prep agent for /build-batch wave ${waveNum}. (Self-contained — all steps are inline below; you run in the app repo cwd, where the workflow spec is not present, so do NOT try to read workflows/build-batch.spec.md.)

For each bead in ${JSON.stringify(prepCandidates.map(c => ({ id: c.id })))}:
1. \`bd update <id> --claim\`. If exit≠0, the bead was raced — push into "failed" with reason "claim failed (raced)" and skip the rest for this bead.
2. Create the worktree. **KNOWN bd 0.55.4 BUG (autonomous-build-ahj):** \`bd worktree create\` prints "Error: failed to create worktree: exit status 128 ... already exists" and exits NONZERO **even when it fully creates a usable worktree** (dir + branch + synced issues.jsonl; \`bd ready\`/\`bd show\` work inside). So do NOT trust its exit code — verify the worktree exists instead. Let REPO = \`git rev-parse --show-toplevel\` and WT = "\${REPO}/task-<id>".
   a. Pre-clean a stale collision from a prior wave: if \`git worktree list --porcelain\` shows a worktree at WT, run \`bd worktree remove "task-<id>" --force\` then \`git worktree prune\`; if \`git branch --list "bead/<id>"\` is non-empty, run \`git branch -D "bead/<id>"\`.
   b. Run \`bd worktree create "task-<id>" --branch "bead/<id>"\` and IGNORE its (spuriously nonzero) exit code. Pass --branch explicitly: the bare form defaults branch=name=task-<id>, but the merge step uses \`bead/<id>\`.
   c. VERIFY (this, not the exit code, is the success test): \`git worktree list --porcelain\` must list \`worktree <WT>\` with \`branch refs/heads/bead/<id>\`, AND the directory WT must exist with checked-out files.
   d. If verified → SUCCESS (worktreePath = WT). ONLY if verification fails: \`bd update <id> --status=blocked --notes "worktree create failed"\`, push into "failed" with reason "worktree create failed", and skip.
3. On success, push into "prepped": { "beadId": "<id>", "worktreePath": "<WT, i.e. repo-root/task-<id>>", "branch": "bead/<id>" }.

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
  // Each worker thunk races the agent dispatch against a stage timeout. We can't
  // TaskStop an agent() dispatch, but racing lets the orchestrator stop waiting
  // on a wedged worker and block its bead instead of stalling the batch.
  const buildTasks = prepped.map(p => () => {
    let timer;
    let work = Promise.resolve()
      .then(() => agent(`
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
- Run the quality gate with \`GATE_RESTAMP=off GATE_REQUIRE_BASELINE=1\` in the environment (resolve cross-platform: prefer \`<repo-root>/hooks/post-build-gate.{sh,ps1}\`, else the sibling \`../autonomous-build/hooks/\`; run \`GATE_RESTAMP=off GATE_REQUIRE_BASELINE=1 post-build-gate.sh\` on Linux/macOS, \`$env:GATE_RESTAMP='off'; $env:GATE_REQUIRE_BASELINE='1'; pwsh -NoProfile -File post-build-gate.ps1\` on Windows). \`GATE_RESTAMP=off\` is REQUIRED here: you are one of several PARALLEL workers and the Jankurai baseline (\`agent/baselines/main.repo-score.json\`) is shared — if each worker re-stamped it on its own branch, the divergent baseline commits would collide at merge time and block good beads. The serialized post-merge gate on main owns the high-water advance instead. \`GATE_REQUIRE_BASELINE=1\` is also REQUIRED: build-batch is always app mode (Phase 0 refuses meta), so a missing baseline is a /decompose bug — the gate must hard-fail, not silently skip (igu.3). On red, retry with a *different* fix up to the bead's budget = plan.lock.escalationBudget.maxFailuresPerTask (default 2), +2 if this bead has dependents or is P0/P1 (load-bearing beads earn more attempts — stranding them wastes the downstream subtree, lbq.19); block on the final failure.
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
    // If the runtime has no timers, degrade to the prior no-timeout behavior
    // rather than crashing on a missing global (strictly no worse than before).
    if (typeof setTimeout !== 'function') return work;
    work = work.then(r => { clearTimeout(timer); return r; },
                     e => { clearTimeout(timer); throw e; });
    work.catch(() => {});  // swallow a late rejection if work loses the race
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        log(`[TIMEOUT] ${p.beadId} exceeded ${STAGE_TIMEOUT_MIN}min without BUILD_COMPLETE — abandoning worker, blocking bead`);
        resolve({ status: 'timeout', beadId: p.beadId, notes: `worker timeout after ${STAGE_TIMEOUT_MIN} min` });
      }, STAGE_TIMEOUT_MIN * 60 * 1000);
    });
    return Promise.race([work, timeout]);
  });

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

    if (marker.status === 'timeout') {
      // Synthetic marker from the stage-timeout race — the abandoned worker
      // never set bd state, so the orchestrator must mark the bead blocked.
      // Leave the worktree: the worker may still be holding it; the human needs
      // that state to see where it wedged.
      log(`[WORKER] ${p.beadId} timed out — blocking bead; worktree left at ${p.worktreePath} for inspection`);
      await agent(`Run: bd update ${p.beadId} --status=blocked --notes "${marker.notes}". Return { "ok": true } or { "ok": false, "reason": "..." }.`,
        { label: `timeout-block-${p.beadId}`, phase: 'Dispatch + drain', agentType: 'general-purpose' });
      blockedSet.push(p.beadId);
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
      // Failed = unexpected error, the most severe outcome — must NOT be silent.
      // Mark the bead blocked with a diagnostic note so it surfaces in `bd
      // blocked` and the Phase-3 /escalate notification reaches the human.
      // Leave the worktree intact (spec: failed worktrees need eyes to debug).
      log(`[WORKER] ${p.beadId} failed: ${marker.notes || '(no notes)'}`);
      log(`  Worktree left at ${p.worktreePath} for human inspection.`);
      const note = `worker failed unexpectedly: ${marker.notes || '(no notes)'} — worktree left at ${p.worktreePath} for inspection`;
      await agent(`Run: bd update ${p.beadId} --status=blocked --notes ${JSON.stringify(note)}. Return { "ok": true } or { "ok": false, "reason": "..." }.`,
        { label: `failed-block-${p.beadId}`, phase: 'Dispatch + drain', agentType: 'general-purpose' });
      failedSet.push(p.beadId);
      continue;
    }

    if (marker.status === 'ready-to-merge') {
      log(`[WORKER] ${p.beadId} completed (sha ${marker.commitSha || '?'}) → merge`);

      const mergeResult = await agent(`
You are the merge agent for /build-batch, bead=${p.beadId}. (Self-contained — all steps are inline below; you run in the app repo cwd, where the workflow spec is not present, so do NOT try to read workflows/build-batch.spec.md.)

This call is the ONLY merger running right now — the orchestrator awaits it before processing the next ready-to-merge bead. Do NOT spawn parallel git operations.

Steps (all from the repo root: \`git rev-parse --show-toplevel\`):
1. \`git checkout main\`.
2. \`git remote\`. If non-empty list:
   - \`git pull --ff-only origin main\`. If exit≠0:
     - \`bd update ${p.beadId} --status=blocked --notes "git pull --ff-only origin main failed before merge — local main is behind remote and cannot fast-forward"\`.
     - Return { "ok": false, "reason": "pull-failed" }.
3. \`git merge --no-ff ${p.branch} -m "Merge ${p.beadId}"\`. If exit≠0 (conflict):
   - \`git merge --abort\` to restore main.
   - AUTO-REBASE RETRY (shared config/barrel/lockfiles conflict mechanically and usually rebase cleanly; a conflict-block should not be the first response when the human is furthest away):
     a. \`git checkout ${p.branch}\`
     b. \`git rebase main\`.
        - If the rebase reports conflicts: \`git rebase --abort\`, \`git checkout main\`, then \`bd update ${p.beadId} --status=blocked --notes "merge conflict against main; auto-rebase also conflicted — needs manual resolution" --append-notes "<conflict output>"\`. Return { "ok": false, "reason": "merge-conflict" }.
        - If the rebase succeeds: \`git checkout main\`, then RE-ATTEMPT \`git merge --no-ff ${p.branch} -m "Merge ${p.beadId}"\`.
          - If this second merge still fails: \`git merge --abort\`, \`bd update ${p.beadId} --status=blocked --notes "merge conflict against main; persisted after auto-rebase" --append-notes "<merge output>"\`. Return { "ok": false, "reason": "merge-conflict" }.
          - If it succeeds: fall through to Step 4 (the gate below re-runs on the rebased+merged result — this is the "re-run gate after rebase").
   (After a successful rebase the branch's commit shas change; that is expected and fine — nothing downstream reuses the worker's original commitSha.)
4. Run the quality gate with \`GATE_REQUIRE_BASELINE=1\` in the environment (resolve cross-platform: prefer \`<repo-root>/hooks/post-build-gate.{sh,ps1}\`, else the sibling \`../autonomous-build/hooks/\`; \`GATE_REQUIRE_BASELINE=1 post-build-gate.sh\` on Linux/macOS, \`$env:GATE_REQUIRE_BASELINE='1'; pwsh -NoProfile -File post-build-gate.ps1\` on Windows). \`GATE_REQUIRE_BASELINE=1\` is REQUIRED — build-batch is always app mode, so a missing baseline is a /decompose bug the gate must hard-fail on, not skip (igu.3). Do NOT set \`GATE_RESTAMP=off\` here — this is the SERIALIZED post-merge gate on main, the one path that owns the Jankurai baseline high-water re-stamp (rule 7); the parallel per-worker gates suppressed it precisely so this one advances the baseline cleanly. If exit≠0:
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

  // Checkpoint the processed sets so a crash/restart resumes here (lbq.7).
  await checkpoint();

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

log(`[BATCH COMPLETE]`);
log(`  Merged:   ${mergedSet.length} beads → ${mergedSet.join(', ') || '(none)'}`);
log(`  Blocked:  ${blockedSet.length} beads → ${blockedSet.join(', ') || '(none)'}`);
log(`  Failed:   ${failedSet.length} beads → ${failedSet.join(', ') || '(none)'}`);

// Post-action decision: /escalate if blockedSet OR failedSet non-empty (failed
// beads were marked blocked above so they notify too); /retro if clean drain.
let postAction = 'none';
const summaryActions = await agent(`
You are the summary agent for /build-batch Phase 3. (Self-contained — all steps are inline below; you run in the app repo cwd, where the workflow spec is not present, so do NOT try to read workflows/build-batch.spec.md.)

Inputs:
  merged:  ${JSON.stringify(mergedSet)}
  blocked: ${JSON.stringify(blockedSet)}
  failed:  ${JSON.stringify(failedSet)}

Note: failed beads have already been marked \`blocked\` (with a "worker failed unexpectedly … worktree left at <path>" note) by the orchestrator, so they appear in \`bd list --status=blocked\` and their worktrees are preserved. Failed is the most severe outcome and must NOT be silent — it escalates like any other block.

Decide and execute the post-action:
1. If blocked.length > 0 OR failed.length > 0:
   - These need a human (blocked = decision; failed = unexpected error to debug). Both are now in \`bd list --status=blocked\`. Also print worktree paths via Bash (\`git worktree list\`) so the human can find any failed-bead worktrees. Record postAction="escalate"; do NOT spawn /escalate as a slash command from within the workflow — the orchestrator turn handles the push notification from \`bd list --status=blocked\`.
2. Else:
   - Run \`bd ready --json\` and filter epics. If the remaining list is empty AND merged.length > 0 (we actually did work and nothing else is ready), record postAction="retro-suggested".
   - Otherwise record postAction="none".

Return JSON: { "postAction": "escalate" | "retro-suggested" | "none", "rationale": "<one sentence>" }
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
  // durationSec omitted: wall-clock is uncomputable inside the Workflow runtime
  // (Date.now()/new Date() forbidden — see beads autonomous-build-4ez / -5fb).
  waveCount: waveNum
};
