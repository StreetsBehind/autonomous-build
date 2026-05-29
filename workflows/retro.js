export const meta = {
  name: 'retro',
  description: 'Workflow performance retro for an app the loop just finished (or is mid-build). Fans out independent analyzer agents per data source, extracts atomic signals, adversarially cross-checks every proposed workflow-improvement bead before filing, and writes a markdown report. Run when /build-next exits DONE or the user says "retro".',
  whenToUse: 'When /build-next exits DONE, /build-batch drains clean, or the user says "retro" / "/retro" / "review the workflow". Use --self for a retro of autonomous-build itself.',
  phases: [
    { title: 'Pre-flight',        detail: 'Verify the app is bd-init\'d; resolve window + meta-path; build Context' },
    { title: 'Data collection',   detail: '6 independent agents, one per data source (beads, app git, meta git, interactions, jankurai, prior retros)' },
    { title: 'Signal extraction', detail: '5 agents turn the raw blobs into atomic typed signals (quality/meta-edit/tenet/jankurai/wins)' },
    { title: 'Cross-check',       detail: 'Per proposed bead: verify-evidence + verify-fix in parallel, then reconcile into file / report-only' },
    { title: 'Synthesis',         detail: 'Write the markdown report and file the cross-checked improvement beads (idempotent)' }
  ]
};

// ---------------------------------------------------------------------------
// Args (same runtime-arg discovery convention as decompose.js / build-batch.js)
// ---------------------------------------------------------------------------
const rawArgs =
  (typeof args !== 'undefined') ? args :
  (typeof userArgs !== 'undefined') ? userArgs :
  (typeof input !== 'undefined') ? input : '';

const parsedArgs = parseArgs(rawArgs);
log(`retro args: ${JSON.stringify(parsedArgs)}`);

function parseArgs(s) {
  // metaPath default is null → the pre-flight agent resolves it via docs/META_PATH_RESOLUTION.md
  // (env → installed-skill-link trace → candidate probe). The old hardcoded path did not exist on
  // every host, so a no-arg run silently dropped to file-only and filed zero beads.
  // phase: scope the retro to ONE phase's build window (epic 0ms). null = the whole build (default,
  // unchanged). With --phase N, the pre-flight resolves the window from phase N's beads (the "Phase N"
  // epic's children) and every collector scopes to that slice; the report feeds /replan for phase N+1.
  const out = { appPath: '.', since: null, until: null, metaPath: null, noFile: false, isSelf: false, isInbox: false, phase: null };
  if (!s) return out;
  const tokens = (typeof s === 'string') ? s.trim().split(/\s+/).filter(Boolean) : (Array.isArray(s) ? s : []);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--app-path' && tokens[i + 1]) { out.appPath = tokens[++i]; }
    else if (tokens[i] === '--since' && tokens[i + 1]) { out.since = tokens[++i]; }
    else if (tokens[i] === '--until' && tokens[i + 1]) { out.until = tokens[++i]; }
    else if (tokens[i] === '--meta-path' && tokens[i + 1]) { out.metaPath = tokens[++i]; }
    else if (tokens[i] === '--no-file') { out.noFile = true; }
    else if (tokens[i] === '--self') { out.isSelf = true; }
    else if (tokens[i] === '--inbox') { out.isInbox = true; }
    else if (tokens[i] === '--phase' && tokens[i + 1]) { const n = parseInt(tokens[++i], 10); if (Number.isInteger(n) && n >= 1) out.phase = n; }
  }
  return out;
}

// ===========================================================================
// Inbox mode (--inbox) — triage drain. Counterpart to /flag --upstream.
// Different SOURCE (existing `triage`-labelled beads in the meta repo, not a
// build window) and different ACTION (promote survivors in place — re-parent +
// drop the triage label — instead of filing new beads). Reuses the Phase 4
// adversarial 2-agent cross-check, then returns before the build-window flow.
// ===========================================================================
if (parsedArgs.isInbox) {
  phase('Inbox pre-flight');

  const inboxPreSchema = {
    type: 'object',
    required: ['status'],
    properties: {
      status: { enum: ['ok', 'failed'] },
      failedReason: { type: 'string' },
      metaPath: { type: 'string' },
      date: { type: 'string' }
    }
  };
  const inboxPre = await agent(`
You are inbox-preflight for /retro --inbox (the triage drain). The triage inbox lives ONLY in the autonomous-build (meta) repo.
Invocation args: ${JSON.stringify(parsedArgs)}
Run IN ORDER and return JSON matching the schema:
1. Resolve metaPath per docs/META_PATH_RESOLUTION.md. If --meta-path was passed ("${parsedArgs.metaPath || ''}" — non-empty means explicit), use it verbatim. Otherwise resolve from \$HOME (do NOT hardcode):
   \`\`\`bash
   META="\$AUTONOMOUS_BUILD_HOME"
   { [ -n "\$META" ] && [ -d "\$META/.beads" ]; } || META="\$(readlink -f ~/.claude/skills/flag 2>/dev/null | xargs -r dirname | xargs -r dirname)"
   { [ -d "\$META/.beads" ] && [ -f "\$META/skills/build-next/SKILL.md" ]; } || for c in "\$HOME/.openclaw/workspace/autonomous-build" "\$HOME/Documents/Github/autonomous-build"; do [ -d "\$c/.beads" ] && [ -f "\$c/skills/build-next/SKILL.md" ] && META="\$c" && break; done
   \`\`\`
   A resolved metaPath must contain BOTH \`.beads/\` and \`skills/build-next/SKILL.md\`.
2. If metaPath does NOT resolve → { "status": "failed", "failedReason": "could not resolve autonomous-build repo; the triage inbox lives only there — set AUTONOMOUS_BUILD_HOME or pass --meta-path" }. (Fail loud, never file-only: there is nothing to drain without the meta repo — T7.)
3. date = "${parsedArgs.until || ''}" if non-empty, else today (YYYY-MM-DD via \`date +%F\`).
Return { "status": "ok", "metaPath": "<absolute path>", "date": "<YYYY-MM-DD>" }.
Use Bash, Read.
`, { label: 'inbox-preflight', phase: 'Inbox pre-flight', schema: inboxPreSchema });

  if (!inboxPre || inboxPre.status !== 'ok' || !inboxPre.metaPath) {
    log(`Triage drain pre-flight failed: ${inboxPre?.failedReason || 'null'}`);
    return { status: 'failed', mode: 'inbox', failedReason: inboxPre?.failedReason || 'inbox-preflight returned null', reportPath: null, promotedBeadIds: [] };
  }
  const metaPath = inboxPre.metaPath;
  const drainDate = inboxPre.date;
  log(`Inbox pre-flight OK — meta=${metaPath}, date=${drainDate}`);

  // --- Collect the triage inbox ---
  phase('Inbox collect');
  const inboxCollectSchema = {
    type: 'object',
    required: ['triage'],
    properties: {
      triage: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'title'],
          properties: {
            id:          { type: 'string' },
            title:       { type: 'string' },
            description: { type: 'string' },
            status:      { type: 'string' },
            labels:      { type: 'array', items: { type: 'string' } },
            fromApp:     { type: ['string', 'null'] },
            category:    { type: ['string', 'null'] }
          }
        }
      }
    }
  };
  const inbox = await agent(`
You are inbox-collect for /retro --inbox. List the triage inbox in the meta repo (${metaPath}).
Run: \`( cd "${metaPath}" && bd list --label triage --all --json )\` — run bd from INSIDE the meta repo so it auto-discovers the DB. Do NOT pass \`--db "${metaPath}/.beads"\`: pointing --db at the .beads *directory* opens an empty/uninitialized DB and \`list\` SILENTLY returns [] (a false "inbox empty"). The \`triage\` label IS the inbox; \`--all\` covers every status.
Keep ONLY un-vetted beads still awaiting triage: status \`open\` or \`in_progress\` (skip \`closed\` — already resolved). For each kept bead capture { id, title, description, status, labels, fromApp (parse the \`from-app:<x>\` label → "<x>", else null), category (parse "Category: <c>" out of the description, else null) }.
Return { "triage": [...] } (empty array if the inbox is empty). If bd errors, return { "triage": [] } and note it — do NOT throw (T7).
Use Bash.
`, { label: 'inbox-collect', phase: 'Inbox collect', schema: inboxCollectSchema, agentType: 'general-purpose' });

  const triage = (inbox && Array.isArray(inbox.triage)) ? inbox.triage : [];
  log(`Inbox: ${triage.length} un-vetted triage bead(s)`);

  if (triage.length === 0) {
    phase('Inbox report');
    const emptySchema = { type: 'object', required: ['reportPath'], properties: { status: { type: 'string' }, reportPath: { type: ['string', 'null'] } } };
    const emptyReport = await agent(`
Write a short markdown report to "${metaPath}/retros/triage-drain-${drainDate}.md" via the Write tool (\`mkdir -p "${metaPath}/retros"\` first). Body:
"# Triage drain (${drainDate})

Inbox empty — no un-vetted \`triage\` beads to drain.
"
Return { "status": "ok", "reportPath": "<path>" }.
`, { label: 'inbox-report-empty', phase: 'Inbox report', schema: emptySchema, agentType: 'general-purpose' });
    log('Triage drain: inbox empty — nothing to promote.');
    return { status: 'ok', mode: 'inbox', reportPath: emptyReport?.reportPath || null, epicId: null, promotedBeadIds: [], uncertainCount: 0, failedToPromoteCount: 0 };
  }

  // --- Adversarial cross-check: same 2-verifier pattern as Phase 4, per triage bead ---
  phase('Inbox cross-check');
  const evidenceSchemaI = { type: 'object', required: ['supports'],   properties: { supports:   { type: 'boolean' }, note:             { type: 'string' } } };
  const fixSchemaI      = { type: 'object', required: ['verifiable'], properties: { verifiable: { type: 'boolean' }, suggestedRewrite: { type: 'string' } } };

  const checkedInbox = await parallel(triage.map((b, idx) => () =>
    Promise.all([
      agent(`
You are verify-evidence for the triage drain (bead ${b.id}). A triage bead is a RAW observation filed via /flag --upstream — your job is to check whether it actually holds up. You see ONLY the observation and its cited evidence (NOT any proposed fix). Use Bash/Read/Grep to inspect the cited files / ids in ${metaPath} (or the named from-app repo if reachable) and decide: does real evidence support the observation?
Observation (title — description): ${JSON.stringify((b.title || '') + ' — ' + (b.description || ''))}
from-app: ${JSON.stringify(b.fromApp)}
Return { "supports": true|false, "note": "<what you checked and found>" }. Default supports=false if the evidence cannot be located or does not bear out the claim.`,
        { label: `inbox-verify-evidence-${idx}`, phase: 'Inbox cross-check', schema: evidenceSchemaI, agentType: 'general-purpose' }),
      agent(`
You are verify-fix for the triage drain (bead ${b.id}). Triage beads are raw and usually carry NO acceptance. Given the observation, judge whether a CONCRETE, self-verifiable acceptance criterion is derivable — one a grep / file-exists / line-count / gate-pass check on a file in autonomous-build could PROVE. If so, supply it.
Observation (title — description): ${JSON.stringify((b.title || '') + ' — ' + (b.description || ''))}
Return { "verifiable": true|false, "suggestedRewrite": "<the concrete AC — REQUIRED whenever verifiable=true; \\"\\" only if genuinely not verifiable>" }.`,
        { label: `inbox-verify-fix-${idx}`, phase: 'Inbox cross-check', schema: fixSchemaI, agentType: 'general-purpose' })
    ]).then(([ev, fx]) => ({ bead: b, ev, fx }))
  ));

  // Reconcile (pure JS) — same bins as Phase 4: survivors get promoted, the rest stay in the inbox.
  const promote = [];
  const uncertain = [];
  for (const c of checkedInbox) {
    if (!c) { continue; }
    const { bead, ev, fx } = c;
    const evOk = ev && ev.supports === true;
    const fxOk = fx && fx.verifiable === true;
    if (evOk && fxOk) {
      promote.push({ bead, acceptance: (fx && fx.suggestedRewrite) || null, verification: 'evidence ✓, fix ✓', verdicts: { ev, fx } });
    } else if (evOk && fx && fx.suggestedRewrite) {
      promote.push({ bead, acceptance: fx.suggestedRewrite, verification: 'fix ✓ after rewrite', verdicts: { ev, fx } });
    } else {
      uncertain.push({ bead, bin: (!evOk && fxOk) ? 'disagree' : 'report-only', verdicts: { ev, fx } });
    }
  }
  log(`Inbox cross-check: ${promote.length} to promote, ${uncertain.length} stay in inbox (of ${triage.length})`);

  // --- Promote survivors in place: re-parent under a per-drain epic, drop the triage label ---
  phase('Inbox promote');
  let epicId = null;
  const promotedBeadIds = [];
  const failedToPromote = [];
  if (promote.length > 0) {
    const promoteSchema = {
      type: 'object',
      required: ['promotedBeadIds'],
      properties: {
        epicId:          { type: ['string', 'null'] },
        promotedBeadIds: { type: 'array', items: { type: 'string' } },
        failedToPromote: { type: 'array', items: { type: 'object' } }
      }
    };
    const promoteInput = promote.map(p => ({ id: p.bead.id, title: p.bead.title, acceptance: p.acceptance, verification: p.verification }));
    const promoted = await agent(`
You are inbox-promote for /retro --inbox. Promote vetted triage beads IN PLACE in the meta repo (${metaPath}). Run every bd command from INSIDE the meta repo: \`( cd "${metaPath}" && bd ... )\` so it auto-discovers the DB. Do NOT pass \`--db "${metaPath}/.beads"\`: pointing --db at the .beads *directory* opens an empty/uninitialized DB — \`list\` silently returns [] and \`create\`/\`update\` hard-error 'database not initialized: issue_prefix config is missing'.
Survivors to promote: ${JSON.stringify(promoteInput)}

Steps (Bash + bd):
1. IDEMPOTENCY: look for an existing per-drain epic for this date — \`( cd "${metaPath}" && bd list --label triage-drain --label retro-date:${drainDate} --all )\`. If one exists, reuse its ID; otherwise create it: \`( cd "${metaPath}" && bd create "Triage drain (${drainDate})" --type=epic --priority=2 --labels "workflow-improvement,triage-drain,retro-date:${drainDate}" )\` and capture the new ID. (bd create takes \`--labels <comma-separated>\`, NOT --add-label.)
2. For EACH survivor, one update call: \`( cd "${metaPath}" && bd update <id> --parent <epicId> --remove-label triage )\` — re-parents it under the drain epic AND drops the \`triage\` label so it leaves the inbox. Do NOT touch its other labels (\`workflow-improvement\`, \`from-app:<app>\` stay). If the survivor's acceptance field above is non-null, ALSO pass \`--acceptance "<that acceptance>"\`.
3. If any bd call errors, record { "id": <id>, "error": <message> } under failedToPromote and continue — do NOT crash (T7).
Return { "epicId": "<id|null>", "promotedBeadIds": [<ids actually re-parented + de-triaged>], "failedToPromote": [...] }.
`, { label: 'inbox-promote', phase: 'Inbox promote', schema: promoteSchema, agentType: 'general-purpose' });
    epicId = promoted?.epicId || null;
    promotedBeadIds.push(...((promoted && promoted.promotedBeadIds) || []));
    failedToPromote.push(...((promoted && promoted.failedToPromote) || []));
  }

  // --- Report ---
  phase('Inbox report');
  const inboxReportSchema = { type: 'object', required: ['status', 'reportPath'], properties: { status: { enum: ['ok', 'failed'] }, reportPath: { type: ['string', 'null'] }, reportMarkdown: { type: 'string' } } };
  const inboxReport = await agent(`
You are inbox-report for /retro --inbox. Write the triage-drain report to "${metaPath}/retros/triage-drain-${drainDate}.md" via the Write tool (\`mkdir -p "${metaPath}/retros"\` first).
Inputs:
- date: ${drainDate}
- epicId: ${JSON.stringify(epicId)}
- promoted (now under the drain epic, \`triage\` label dropped): ${JSON.stringify(promote.map(p => ({ id: p.bead.id, title: p.bead.title, fromApp: p.bead.fromApp, verification: p.verification, acceptance: p.acceptance })))}
- promotedBeadIds: ${JSON.stringify(promotedBeadIds)}
- uncertain (LEFT in the inbox — still labelled \`triage\` — for human triage): ${JSON.stringify(uncertain.map(u => ({ id: u.bead.id, title: u.bead.title, fromApp: u.bead.fromApp, bin: u.bin, verdicts: u.verdicts })))}
- failedToPromote: ${JSON.stringify(failedToPromote)}
- counts: inbox=${triage.length}, promoted=${promotedBeadIds.length}, uncertain=${uncertain.length}

Sections (fill every one): "# Triage drain (${drainDate})" header with a one-line summary (inbox size, promoted, uncertain); ## Promoted — one entry per promoted bead: id, title, from-app, the epic it now sits under, verification, and its acceptance; ## Uncertain (stay in inbox) — one entry per non-survivor with BOTH verifier verdicts (evidence + fix) so a human can see why it didn't survive; if failedToPromote is non-empty add a LOUD "## FAILED TO PROMOTE" section with ids + errors for manual repair.
Return { "status": "ok", "reportPath": "<path>" }. If Write fails, retry once; on a second failure return { "status": "failed", "reportPath": null, "reportMarkdown": "<the body inlined>" }.
`, { label: 'inbox-report', phase: 'Inbox report', schema: inboxReportSchema, agentType: 'general-purpose' });

  if (!inboxReport || inboxReport.status !== 'ok' || !inboxReport.reportPath) {
    log(`Triage-drain report write did NOT succeed. Inlined below:\n${inboxReport?.reportMarkdown || '<none>'}`);
  }
  log(`Triage drain: promoted ${promotedBeadIds.length} under ${epicId || '(no epic)'}; ${uncertain.length} left in inbox; report ${inboxReport?.reportPath || '(write failed)'}`);
  return {
    status: 'ok',
    mode: 'inbox',
    reportPath: inboxReport?.reportPath || null,
    epicId,
    promotedBeadIds,
    uncertainCount: uncertain.length,
    failedToPromoteCount: failedToPromote.length
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — Pre-flight (sequential, 1 agent)
// ---------------------------------------------------------------------------
phase('Pre-flight');

const preflightSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { enum: ['ok', 'no-work', 'failed'] },
    failedReason: { type: 'string' },
    context: {
      type: 'object',
      required: ['appName', 'appPath', 'metaPath', 'metaAvailable', 'since', 'until', 'isSelf'],
      properties: {
        appName:       { type: 'string' },
        appPath:       { type: 'string' },
        metaPath:      { type: 'string' },
        metaAvailable: { type: 'boolean' },
        since:         { type: 'string' },
        until:         { type: 'string' },
        isSelf:        { type: 'boolean' }
      }
    }
  }
};

const preflight = await agent(`
You are the pre-flight agent for the /retro dynamic workflow. (Self-contained: all instructions inline; you run from the invoking cwd.)

Invocation args: ${JSON.stringify(parsedArgs)}

Run these checks IN ORDER and return JSON matching the schema:
1. Resolve metaPath (the autonomous-build repo) per docs/META_PATH_RESOLUTION.md. If the invocation passed --meta-path ("${parsedArgs.metaPath || ''}" — non-empty means explicit), use it verbatim. Otherwise resolve from \$HOME with this bash (do NOT hardcode):
   \`\`\`bash
   META="\$AUTONOMOUS_BUILD_HOME"
   { [ -n "\$META" ] && [ -d "\$META/.beads" ]; } || META="\$(readlink -f ~/.claude/skills/flag 2>/dev/null | xargs -r dirname | xargs -r dirname)"
   { [ -d "\$META/.beads" ] && [ -f "\$META/skills/build-next/SKILL.md" ]; } || for c in "\$HOME/.openclaw/workspace/autonomous-build" "\$HOME/Documents/Github/autonomous-build"; do [ -d "\$c/.beads" ] && [ -f "\$c/skills/build-next/SKILL.md" ] && META="\$c" && break; done
   \`\`\`
   A resolved metaPath must contain BOTH \`.beads/\` and \`skills/build-next/SKILL.md\`.
2. Resolve appPath: if --self, appPath = metaPath (REQUIRED — if metaPath did not resolve in step 1, → { "status": "failed", "failedReason": "--self but could not resolve autonomous-build repo; set AUTONOMOUS_BUILD_HOME" }) and appName = "autonomous-build"; else appPath = "${parsedArgs.appPath}" (resolve to absolute) and appName = basename(appPath).
3. \`bd info\` in appPath. If it errors (not bd-initialized) → { "status": "failed", "failedReason": "app repo not bd-initialized at <appPath>" }.
4. Resolve the window:
   - **Phase scope (epic 0ms):** ${parsedArgs.phase ? `this is a PHASE ${parsedArgs.phase} retro. Find the epic whose title starts with "Phase ${parsedArgs.phase}" (\`bd list --type=epic --all --json\`). Resolve the window from ITS children only: since = the earliest child created_at, until = the latest child closed_at (or today's date if any child is still open). If no "Phase ${parsedArgs.phase}" epic exists → { "status": "no-work", "failedReason": "no Phase ${parsedArgs.phase} epic — nothing built for that phase yet" }. Explicit --since/--until below override these if given.` : 'no --phase given — use the whole-build window below.'}
   - since: if "${parsedArgs.since || ''}" is empty${parsedArgs.phase ? ' and no phase window resolved above' : ''}, query \`bd query "status in (in_progress, closed) ORDER BY created_at ASC LIMIT 1"\` and use that created_at date (YYYY-MM-DD). bd <=0.55.x emits no claimed_at, so created_at is the only reliable start. If there are NO closed/in_progress beads → { "status": "no-work" } (nothing to retro).
   - until: "${parsedArgs.until || ''}" or today's date.
5. Check metaPath resolved AND metaPath/.beads/ exists → metaAvailable=true; else metaAvailable=false. If false, log a LOUD line ("meta-path unresolved — file-only mode; set AUTONOMOUS_BUILD_HOME or pass --meta-path to file beads") so the no-file fallback is never silent.
6. Return { "status": "ok", "context": { appName, appPath, metaPath, metaAvailable, since, until, isSelf: ${parsedArgs.isSelf} } } (metaPath = the resolved absolute path, or "" if unresolved).

Use Bash, Read. Failures stop the workflow (T1, T7).
`, { label: 'preflight', phase: 'Pre-flight', schema: preflightSchema });

if (!preflight || preflight.status === 'failed') {
  log(`Retro pre-flight failed: ${preflight?.failedReason || 'null'}`);
  return { status: 'failed', failedReason: preflight?.failedReason || 'preflight returned null', reportPath: null, filedBeadIds: [] };
}
if (preflight.status === 'no-work') {
  log('Retro: no closed/in-progress beads in window — nothing to retro.');
  return { status: 'no-work', reportPath: null, filedBeadIds: [], note: 'no closed issues in window' };
}
const Context = { ...preflight.context, phase: parsedArgs.phase };
log(`Pre-flight OK — app=${Context.appName}, window=${Context.since}..${Context.until}${Context.phase ? `, phase=${Context.phase}` : ''}, metaAvailable=${Context.metaAvailable}, self=${Context.isSelf}`);

// ---------------------------------------------------------------------------
// Phase 2 — Data collection (parallel fan-out, 6 agents)
// Each source returns a typed blob or { status: "failed"|"empty", reason }.
// Collection is mechanical and isolated — no cross-source reasoning here.
// ---------------------------------------------------------------------------
phase('Data collection');

const blobSchema = { type: 'object' };  // each collector defines its own shape; keep the wrapper permissive
const collect = (label, prompt) => () => agent(prompt, { label, phase: 'Data collection', schema: blobSchema, agentType: 'general-purpose' });
const W = `Window: ${Context.since}..${Context.until}. App: ${Context.appPath}. Meta: ${Context.metaPath}.${Context.phase ? ` PHASE SCOPE (epic 0ms): this retro covers PHASE ${Context.phase} ONLY — scope every source to beads under the "Phase ${Context.phase}" epic (and to the window above, which is that phase's build slice). Ignore other phases' beads/commits.` : ''}`;
const T7 = `If this source errors (file missing, bd transient failure, parse error), return { "status": "failed", "reason": "<message>" } — do NOT throw (T7).`;

const collected = await parallel([
  collect('collect-app-beads', `
You are collect-app-beads for /retro Phase 2. ${W}
From appPath, gather (Bash + bd): closed beads in window (\`bd query\`/\`bd list\`), flagged (\`bd list --label workflow-issue\`), blocked (\`bd list --status=blocked\` — the status field, not \`bd blocked\`, which lists only dependency-blocked beads and misses the ones the loop marked; autonomous-build-gh4), in_progress (\`bd list --status=in_progress\`).
For each closed bead capture {id, title, type, priority, labels, claimedAt, closedAt, created_to_closed_sec, retries, parentEpic}. If claimed_at is absent (bd <=0.55.x), use created_at as the start and set created_to_closed_sec = closedAt − createdAt (name it exactly that so downstream knows it's created-to-closed).
Return { "closed": [...], "flagged": [...], "blocked": [...], "inProgress": [...] }. ${T7}`),

  collect('collect-app-git', `
You are collect-app-git for /retro Phase 2. ${W}
In appPath via git: commits in window (\`git log --since --until --format\` with sha/ts/subject/author/files), reverts (\`git log --grep=Revert\`), post-close edits (a bead's files edited by a non-loop commit after its closing commit — record {beadId, loopSha, userSha, hoursAfter, files}), and sub-30s closes (beads whose created_to_closed_sec < 30).
Return { "commits": [...], "reverts": [...], "postCloseEdits": [...], "subThirtySecondCloses": [...] }. ${T7}`),

  collect('collect-meta-git', `
You are collect-meta-git for /retro Phase 2. ${W}
In metaPath (${Context.metaPath}) via git log for the window, bucket edited files by path category: skills/, formulas/, hooks/, docs/, *tenets*, schemas/, templates/, other. For each bucket list {file, shas, subjects}.
This captures workflow files edited DURING the build window — each is a workflow gap (the workflow needed adjusting live). If metaAvailable is false, return { "status": "empty", "reason": "meta-path has no .beads" }.
Return { "skills": [...], "formulas": [...], "hooks": [...], "docs": [...], "tenets": [...], "schemas": [...], "templates": [...], "other": [...] }. ${T7}`),

  collect('collect-interactions', `
You are collect-interactions for /retro Phase 2. ${W}
Read appPath/.beads/interactions.jsonl (OPTIONAL — many bd installs don't emit it). If missing or 0 bytes, return { "status": "empty" } (expected, NOT a failure). Otherwise filter to the window and aggregate per-bead { toolCallCount, toolBreakdown, gateInvocations, gateOutcomes } plus totals.
Return { "perBead": {...}, "totals": {...} } or { "status": "empty" }. ${T7}`),

  collect('collect-jankurai', `
You are collect-jankurai for /retro Phase 2. ${W}
Read appPath/target/jankurai/*.json in window. Extract kickoffRefusals [{beadId, reason}], auditFindings [{beadId, count, severities}], witnessRegressions [{beadId, baselineDelta}]. If target/jankurai/ doesn't exist, return {} (empty object, not a failure).
Return { "kickoffRefusals": [...], "auditFindings": [...], "witnessRegressions": [...] }. ${T7}`),

  collect('collect-app-retros', `
You are collect-app-retros for /retro Phase 2. ${W}
Read metaPath/retros/*.md for prior retros of app "${Context.appName}". For each: {path, date, headline, filedBeadIds}. Used to check "what did the prior retro file, and did it close?".
Return { "priorRetros": [...] }. ${T7}`)
]);

const [appBeads, appGit, metaGit, interactions, jankurai, appRetros] = collected;
const sourceStatus = {
  'app-beads': appBeads?.status || 'ok', 'app-git': appGit?.status || 'ok', 'meta-git': metaGit?.status || 'ok',
  'interactions': interactions?.status || 'ok', 'jankurai': jankurai?.status || 'ok', 'app-retros': appRetros?.status || 'ok'
};
log(`Data collection: ${Object.entries(sourceStatus).map(([k, v]) => `${k}=${v}`).join(', ')}`);

// ---------------------------------------------------------------------------
// Phase 3 — Signal extraction (parallel fan-out, 5 agents)
// Each reads the Phase 2 blobs (in script vars) and emits atomic typed signals.
// ---------------------------------------------------------------------------
phase('Signal extraction');

const signalsSchema = {
  type: 'object',
  required: ['signals'],
  properties: {
    signals: {
      type: 'array',
      items: {
        type: 'object',
        required: ['category', 'severity', 'evidence', 'observation'],
        properties: {
          category:    { enum: ['quality', 'speed', 'meta-edit', 'tenet', 'win'] },
          severity:    { enum: ['high', 'medium', 'low'] },
          evidence:    { type: 'object' },   // { source, refs: [...] }
          observation: { type: 'string' },
          proposed:    { type: ['object', 'null'] }  // { title, targetFile, acceptance, labelExtras } | null
        }
      }
    }
  }
};

const SIGNAL_SHAPE = `Each Signal = { category: "quality"|"speed"|"meta-edit"|"tenet"|"win", severity: "high"|"medium"|"low", evidence: { source, refs: [beadIds|shas|filepaths] }, observation: "<one sentence>", proposed: { title, targetFile: "<file in autonomous-build to edit>", acceptance: "<self-verifiable AC: grep / file-exists / line-count / gate-pass>", labelExtras: [...] } | null }. proposed is null for "win".`;
const BLOBS = `Phase 2 blobs:\n- app-beads: ${JSON.stringify(appBeads)}\n- app-git: ${JSON.stringify(appGit)}\n- meta-git: ${JSON.stringify(metaGit)}\n- interactions: ${JSON.stringify(interactions)}\n- jankurai: ${JSON.stringify(jankurai)}`;
const sig = (label, prompt) => () => agent(prompt, { label, phase: 'Signal extraction', schema: signalsSchema, agentType: 'general-purpose' });

const signalResults = await parallel([
  sig('signal-quality', `
You are signal-quality for /retro Phase 3. ${SIGNAL_SHAPE}
${BLOBS}
Emit signals (category "quality" unless noted) for: reverts; post-close edits (medium — incomplete AC); sub-30s closes (low — possible no-op); repeat-blocks on the same formula step (high — structural formula bug); every flagged-issue category (vision-error, formula-issue, gate-issue, escalation-issue, pacing-issue). One signal per concrete observation, each with a self-verifiable proposed AC where a fix is warranted.
Return { "signals": [...] }.`),

  sig('signal-meta-edit', `
You are signal-meta-edit for /retro Phase 3. ${SIGNAL_SHAPE}
${BLOBS}
Every skill/formula/hook/gate/tenet/schema/template file edited DURING the build window is a workflow gap — the workflow needed adjusting live. Emit one HIGH-severity "meta-edit" signal per edited file, with proposed.targetFile = the file and proposed.acceptance = "the documented pattern that motivated this mid-build edit is captured in <file>". If meta-git is empty/failed, return { "signals": [] }.
Return { "signals": [...] }.`),

  sig('signal-tenet', `
You are signal-tenet for /retro Phase 3. ${SIGNAL_SHAPE}
${BLOBS}
Emit "tenet" signals for: tenets cited in bead notes (working as designed → category "win", proposed null); tenets that SHOULD have fired and didn't (e.g. T4 scope discipline: a bead closed touching files outside its filesTouched); tenets the workflow needs but lacks. If interactions is { status: "empty" }, derive from app-beads + meta-git alone — empty interactions is NOT a missing-data failure.
Return { "signals": [...] }.`),

  sig('signal-jankurai', `
You are signal-jankurai for /retro Phase 3. ${SIGNAL_SHAPE}
${BLOBS}
Emit signals for: kickoff refusals (bead spec too broad — formula AC undercooked, high); audit findings the gate let through; witness regressions that should have failed the gate but didn't. If jankurai blob is empty, return { "signals": [] }.
Return { "signals": [...] }.`),

  sig('signal-wins', `
You are signal-wins for /retro Phase 3. ${SIGNAL_SHAPE}
${BLOBS}
Emit "win" signals (proposed: null) for: formulas that poured cleanly + closed first try; gate catches on real failures; escalations the human resolved quickly. These are memory candidates and prevent the workflow drifting toward over-engineering.
Return { "signals": [...] }.`),

  sig('signal-semantic', `
You are signal-semantic for /retro Phase 3 — three structural detectors the smbuild retros needed but could NOT auto-detect. ${SIGNAL_SHAPE}
${BLOBS}
App path: ${Context.appPath}. Meta path: ${Context.metaPath}.
Run these THREE detectors (Bash/Read/Grep against appPath; read ${Context.metaPath}/docs/DEFAULT_STACK.md for #1):
1. formula-pick vs DEFAULT_STACK: read appPath/plan.lock.json (the formula pick per feature) and ${Context.metaPath}/docs/DEFAULT_STACK.md. Emit a HIGH "quality" signal for each feature that poured a GENERIC fallback formula (app-skeleton, crud-feature, background-job, integration-http) where a stack-native variant exists (app-skeleton-rust-cargo, app-skeleton-vite-react, crud-feature-rust, ...), OR any stack choice diverging from the pinned stack (e.g. SQLite instead of PostgreSQL, a Python backend service). proposed.targetFile = the formula or plan.lock entry; acceptance = a grep proving the native variant / pinned stack is used.
2. quality-scored-zero: from the jankurai blob (+ appPath/target/jankurai/*.json and appPath/agent/baselines/*.repo-score.json if present), emit a HIGH "quality" signal for any bead/commit whose jankurai quality score is 0 (or repo-score collapsed to 0) — a quality failure the gate let through. proposed.acceptance = a check that the score is > 0 / the gate hard-fails on score 0.
3. cross-dep edges declared != present: compare the bead DAG's declared dependencies (app-beads blob: blocked-by / parent edges) against actual code cross-dependencies (app-git file lists + grep imports/calls between the modules those beads produced). Emit a "quality" signal per MISMATCH — a code edge with NO declared bead dep (hidden coupling), or a declared dep with NO code edge (phantom edge). proposed.acceptance = the specific edge to add/remove, or a decompose-time check.
Emit NOTHING for a detector whose inputs are absent (no plan.lock.json, no jankurai receipts, etc.) — return only real findings.
Return { "signals": [...] }.`)
]);

// Flatten + dedupe on (category, sorted evidence refs).
const allSignals = signalResults.filter(Boolean).flatMap(r => r?.signals || []);
const seen = new Set();
const signals = allSignals.filter(s => {
  const refs = ((s.evidence && s.evidence.refs) || []).slice().sort().join('|');
  const key = `${s.category}::${refs}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
const proposedSignals = signals.filter(s => s.proposed);
log(`Signals: ${signals.length} total (${proposedSignals.length} carry a proposed bead, ${signals.length - proposedSignals.length} report/win)`);

// ---------------------------------------------------------------------------
// Phase 4 — Adversarial cross-check (2 verifiers per proposed signal + reconcile)
// Every signal carrying a proposed bead must pass two INDEPENDENT verifiers.
// ---------------------------------------------------------------------------
phase('Cross-check');

const evidenceSchema = { type: 'object', required: ['supports'], properties: { supports: { type: 'boolean' }, note: { type: 'string' } } };
const fixSchema = { type: 'object', required: ['verifiable'], properties: { verifiable: { type: 'boolean' }, suggestedRewrite: { type: 'string' } } };

// Per signal, run the two verifiers in parallel; parallel() of all signals
// pipelines them (runtime caps concurrency at 16, so batching is automatic).
const checked = await parallel(proposedSignals.map((s, idx) => () =>
  Promise.all([
    agent(`
You are verify-evidence for /retro Phase 4 (signal ${idx}). You see ONLY the observation and the cited evidence refs — NOT the proposed fix. Does the evidence actually support the observation?
Observation: ${JSON.stringify(s.observation)}
Evidence: ${JSON.stringify(s.evidence)}
Return { "supports": true|false, "note": "<why>" }.`, { label: `verify-evidence-${idx}`, phase: 'Cross-check', schema: evidenceSchema, agentType: 'general-purpose' }),
    agent(`
You are verify-fix for /retro Phase 4 (signal ${idx}). Given the observation and the proposed fix, is the AC concrete enough that the gate or a grep could PROVE the fix worked?
Observation: ${JSON.stringify(s.observation)}
Proposed: ${JSON.stringify(s.proposed)}
Return { "verifiable": true|false, "suggestedRewrite": "<sharper AC, only if not verifiable as written>" }.`, { label: `verify-fix-${idx}`, phase: 'Cross-check', schema: fixSchema, agentType: 'general-purpose' })
  ]).then(([ev, fx]) => ({ signal: s, ev, fx }))
));

// Reconcile (pure JS — mechanical binning).
const toFile = [];
const reportOnly = [];
for (const c of checked) {
  if (!c) { continue; }
  const { signal, ev, fx } = c;
  const evOk = ev && ev.supports === true;
  const fxOk = fx && fx.verifiable === true;
  if (evOk && fxOk) {
    toFile.push({ ...signal, verification: 'evidence ✓, fix ✓' });
  } else if (evOk && fx && fx.suggestedRewrite) {
    toFile.push({ ...signal, proposed: { ...signal.proposed, acceptance: fx.suggestedRewrite }, verification: 'fix ✓ after rewrite' });
  } else if (!evOk && fxOk) {
    reportOnly.push({ ...signal, bin: 'disagree', verdicts: { ev, fx } });
  } else {
    reportOnly.push({ ...signal, bin: 'report-only', verdicts: { ev, fx } });
  }
}
log(`Cross-check: ${toFile.length} fileable, ${reportOnly.length} report-only (of ${proposedSignals.length} proposed)`);

// ---------------------------------------------------------------------------
// Phase 5 — Synthesis & file (sequential, 2 agents)
// ---------------------------------------------------------------------------
phase('Synthesis');

const wins = signals.filter(s => s.category === 'win');
const fileMode = (!Context.metaAvailable || parsedArgs.noFile) ? 'would-file' : 'file';

// file-beads first so the report can link the filed IDs.
let filed = { filedEpicId: null, filedBeadIds: [], failedToFile: [], wouldFile: [] };
if (fileMode === 'file' && toFile.length > 0) {
  const fileSchema = {
    type: 'object',
    required: ['filedBeadIds'],
    properties: {
      filedEpicId:  { type: ['string', 'null'] },
      filedBeadIds: { type: 'array', items: { type: 'string' } },
      failedToFile: { type: 'array', items: { type: 'object' } }
    }
  };
  filed = await agent(`
You are file-beads for /retro Phase 5. File the cross-checked improvements into the meta repo at ${Context.metaPath}. App="${Context.appName}", date="${Context.until}".
Signals to file: ${JSON.stringify(toFile)}

Steps (Bash + bd, from ${Context.metaPath}):
1. IDEMPOTENCY (T8): before creating each, \`bd query "labels CONTAINS 'from-app:${Context.appName}' AND labels CONTAINS 'retro-date:${Context.until}' AND title = <proposed.title>"\` — if a match exists, skip it (already filed in a prior re-run).
2. Create the per-retro epic if not already present this run: \`bd create "Improvements from ${Context.appName} retro (${Context.until})" --type=epic --priority=2 --labels "workflow-improvement,from-app:${Context.appName},retro-date:${Context.until}"\`. Capture its ID. (NOTE: \`bd create\` takes \`--labels <comma-separated>\`, NOT \`--add-label\` — the latter is an update-only flag and errors on create.)
3. For each signal: \`bd create "<proposed.title>" --type=task --priority=2 --parent <epicId> --description "Source: retro-${Context.appName}-${Context.until}. Evidence: <refs>. Verification: <verification>." --acceptance "<proposed.acceptance>" --labels "workflow-improvement,from-app:${Context.appName},retro-date:${Context.until}<,each proposed.labelExtras entry>"\` — fold every labelExtras value into the one comma-separated --labels list.
4. If bd errors at file time, catch it: record under "failedToFile" ({title, spec}) with the full spec for manual re-entry — do NOT crash (T7).
Return { "filedEpicId": "<id|null>", "filedBeadIds": [...], "failedToFile": [...] }.
`, { label: 'file-beads', phase: 'Synthesis', schema: fileSchema, agentType: 'general-purpose' });
  filed.filedBeadIds = filed.filedBeadIds || [];
  filed.failedToFile = filed.failedToFile || [];
} else if (toFile.length > 0) {
  filed.wouldFile = toFile;  // --no-file or metaAvailable=false: surface, don't file (T7)
  log(`File mode "${fileMode}": ${toFile.length} improvements surfaced as would-file (not filed).`);
}

const reportSchema = {
  type: 'object',
  required: ['status', 'reportPath'],
  properties: { status: { enum: ['ok', 'failed'] }, reportPath: { type: ['string', 'null'] }, reportMarkdown: { type: 'string' } }
};
const reportResult = await agent(`
You are write-report for /retro Phase 5. Write the markdown report to \`<reportDir>/retros/retro-${Context.appName}${Context.phase ? `-phase${Context.phase}` : ''}-${Context.until}.md\` via the Write tool, using EXACTLY the spec's section structure.${Context.phase ? ` This is a PHASE ${Context.phase} retro (epic 0ms): its findings are an explicit input to \`/replan --replan-from ${Context.phase + 1}\` — make the Headline + What-didn't sections actionable for re-cutting phase ${Context.phase + 1}.` : ''} <reportDir> = "${Context.metaPath}" if non-empty, else "${Context.appPath}" (meta-path unresolved → keep the report in the analyzed app repo so it is not lost; note this in the Data sources section). \`mkdir -p <reportDir>/retros\` first.

Inputs:
- Context: ${JSON.stringify(Context)}
- source statuses: ${JSON.stringify(sourceStatus)}
- counts: closed=${(appBeads?.closed || []).length}, blocked=${(appBeads?.blocked || []).length}, flagged=${(appBeads?.flagged || []).length}
- wins: ${JSON.stringify(wins)}
- filed: ${JSON.stringify(filed)}
- reportOnly (uncertain — show both verifier verdicts): ${JSON.stringify(reportOnly)}
- crossCheckFileability: ${toFile.length}/${proposedSignals.length}

Sections (fill every one): "# Retro: ${Context.appName}${Context.phase ? ` — phase ${Context.phase}` : ''} (${Context.until})" header line with Window/Mode${Context.phase ? `/Phase (${Context.phase}, feeds /replan ${Context.phase + 1})` : ''}/Tasks/Data sources; ## Headline (one paragraph); ## What worked (from wins — never omit this, it guards against over-engineering); ## What didn't (filed as improvements) — one entry per filed bead with its id, labels, evidence refs, and verification; ## Uncertain (human triage) — from reportOnly with both verdicts; ## Speed metrics table (wall time, median + p90 — label as "created-to-closed" when on the created_at fallback, revert rate, post-close edit rate, flag rate, cross-check fileability rate); ## Data sources (paths + counts + failed/skipped sources). If filed.wouldFile is non-empty, add a "## Would file (not filed: --no-file / no meta .beads)" section. If filed.failedToFile is non-empty, add a loud "## FAILED TO FILE" section with full specs for manual re-entry.

Return { "status": "ok", "reportPath": "<path>" }. If Write fails, retry once; on second failure return { "status": "failed", "reportPath": null, "reportMarkdown": "<the body inlined>" }.
`, { label: 'write-report', phase: 'Synthesis', schema: reportSchema, agentType: 'general-purpose' });

if (!reportResult || reportResult.status !== 'ok' || !reportResult.reportPath) {
  log(`Retro report write did NOT succeed. Inlined below:\n${reportResult?.reportMarkdown || '<none>'}`);
}

const failedSources = Object.entries(sourceStatus).filter(([, v]) => v === 'failed').map(([k]) => k);
log(`Retro: filed ${filed.filedBeadIds.length} improvements${filed.filedEpicId ? ` under ${filed.filedEpicId}` : ''}; ${reportOnly.length} uncertain in ${reportResult?.reportPath || '(report write failed)'}`);

return {
  status: 'ok',
  phase: Context.phase,
  reportPath: reportResult?.reportPath || null,
  filedEpicId: filed.filedEpicId || null,
  filedBeadIds: filed.filedBeadIds || [],
  reportOnlyCount: reportOnly.length,
  wouldFileCount: (filed.wouldFile || []).length,
  failedToFileCount: (filed.failedToFile || []).length,
  failedSources
};
