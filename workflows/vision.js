export const meta = {
  name: 'vision',
  description: 'Workflow half of the hybrid /vision (epic autonomous-build-ih5). Turns a filled vision.md into the frozen skeleton + per-concern decisions the rest of the pipeline builds against. Phase 1 intake validates the product brief (NEEDS-INPUT, never invents content, when §1/§3/§8 are unfilled); Phase 2 builds the frozen skeleton (data model + feature order + stack-native formula picks) and emits the observable signals from which a pure-JS deriveApplicability resolves each of the ten concerns; Phase 3 fans out one agent per APPLICABLE concern over the frozen skeleton, each seeing ONLY its own concern bar — addressed-with-falsifiable-evidence or excluded-with-reason, undecidable -> a concern-decidedness block. Reconcile/assemble (Phase 4) is appended by autonomous-build-ih5.4. SYNC: spec is workflows/vision.spec.md (edit in lockstep, T3); CONCERN_IDS / CONCERN_BARS / EVIDENCE_BAR / GATE_TOKENS mirror docs/PLAN_CONCERNS.md + vision-eval.js; DEFAULT_STACK mirrors docs/DEFAULT_STACK.md.',
  whenToUse: 'Invoked by the /vision skill shell for the concern-derivation engine, or directly (Workflow vision) for a headless run over a vision.md (the path vision-eval grades). Use --no-file to derive without writing, --selftest to CI the pure-JS intake/applicability/skeleton/concern logic with NO agents.',
  phases: [
    { title: 'Intake',   detail: 'Read + validate vision.md; NEEDS-INPUT on unfilled §1/§3/§8 (1 agent)' },
    { title: 'Skeleton', detail: 'Build the frozen skeleton + observable signals; derive applicability in pure JS (1 agent)' },
    { title: 'Concerns', detail: 'Fan out 1 agent per applicable concern over the frozen skeleton (addressed+evidence | excluded+reason | block)' }
    // Phase 4 (reconcile + four gates + decidedness verdict + assemble lock/tenets/plan.md) is appended by autonomous-build-ih5.4.
  ]
};

// ===========================================================================
// Args (same runtime-arg discovery convention as decompose.js / vision-eval.js)
// ===========================================================================
const rawArgs =
  (typeof args !== 'undefined') ? args :
  (typeof userArgs !== 'undefined') ? userArgs :
  (typeof input !== 'undefined') ? input : '';

function parseArgs(s) {
  const out = { visionPath: 'vision.md', skeletonPath: null, outPath: 'plan.lock.json', dryRun: false, selftest: false };
  const tokens = (typeof s === 'string') ? s.trim().split(/\s+/).filter(Boolean) : (Array.isArray(s) ? s : []);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--vision' && tokens[i + 1]) { out.visionPath = tokens[++i]; }
    else if (tokens[i] === '--skeleton' && tokens[i + 1]) { out.skeletonPath = tokens[++i]; }
    else if (tokens[i] === '--out' && tokens[i + 1]) { out.outPath = tokens[++i]; }
    else if (tokens[i] === '--no-file') { out.dryRun = true; }
    else if (tokens[i] === '--selftest') { out.selftest = true; }
  }
  return out;
}
const parsedArgs = parseArgs(rawArgs);

// ===========================================================================
// Inlined consts (SYNC). The workflow runs in the APP cwd where docs/PLAN_CONCERNS.md
// and docs/DEFAULT_STACK.md do NOT exist, so everything an agent needs is inlined as a
// JS const — the same documented-sync discipline vision-eval.js uses for CONCERN_IDS /
// EVIDENCE_BAR / GATE_TOKENS. When the docs change, these change in the same commit.
// ===========================================================================

// SYNC: docs/PLAN_CONCERNS.md "The concern vocabulary" + vision-eval.js CONCERN_IDS (verbatim).
const CONCERN_IDS = [
  'data-model', 'authn', 'authz', 'secrets', 'data-lifecycle',
  'error-handling', 'observability', 'external-integrations', 'perf-envelope', 'abuse-surface'
];

// The load-bearing product sections (by NAME — the intake agent maps headings, not numbers).
// templates/vision.md ships: §1 problem, §3 must-haves, §8 success metric are the three a plan
// cannot be derived without (§5 non-goals / §2 users are read for signals but do not block).
const LOAD_BEARING = ['problem', 'mustHaves', 'successMetric'];

// The observable booleans the skeleton agent reports; deriveApplicability() maps them to tiers.
const SIGNAL_NAMES = [
  'impliesAccounts', 'multipleHumanRoles', 'multiplePrincipals', 'crossUserData',
  'privacyConstraint', 'holdsPii', 'productionOperation', 'externalIntegrations',
  'scaleTarget', 'publicSurface'
];

// SYNC: docs/PLAN_CONCERNS.md "Evidence — what counts" + vision-eval.js EVIDENCE_BAR (verbatim).
// Phase 3 (ih5.3) hands this to each concern agent; vision-eval L4 grades against the same bar.
const EVIDENCE_BAR = `An "addressed" concern's evidence must point at something a verifier can check EXISTS. Falsifiable evidence is ONE of:
  1. a featureOrder[] entry (by name) that delivers the concern,
  2. a formula that encodes it (e.g. oidc-client-rust, otel-bootstrap-rust),
  3. a tenet, by number (e.g. "T7: no swallowed exceptions"),
  4. the quality gate (hooks/post-build-gate.{sh,ps1}),
  5. a DEFAULT_STACK.md pin.
A BARE ASSERTION ("handled", "we handle auth", "we take security seriously", "standard practices", "users log in", "permissions enforced", "we use env vars") is NOT evidence — it is unfalsifiable and FAILS the bar. Naming a concrete mechanism cited to one of the five anchors above passes; a vibe does not.`;

// SYNC: docs/PLAN_CONCERNS.md "The concern vocabulary" table, column "addressed requires (falsifiable)" — verbatim
// per concern. Each Phase-3 concern agent receives ONLY its own line (it must never see the others' contracts or
// outputs — that is the independence the fan-out exists for). One entry per CONCERN_ID (selftest asserts coverage).
const CONCERN_BARS = {
  'data-model': `Every must-have entity appears in the plan's Data model with fields + relationships — not "we'll have a database."`,
  'authn': `Names *who* authenticates (which §2 role) **and** the mechanism, cited to a feature/formula (e.g. "OIDC login for the Operator role via \`oidc-client-rust\`") — not "users log in."`,
  'authz': `The authorization boundary: who may read/write whose data, cited to a feature or enforcement point (e.g. "OpenFGA model: a user reads only their own habits; tenants isolated") — not "permissions enforced."`,
  'secrets': `Where each secret lives + that it is not in the repo, enumerated (e.g. "DB URL + OIDC client secret via env from the host secret store; \`.env\` gitignored") — not "we use env vars."`,
  'data-lifecycle': `Retention/deletion stance for user data **and** whether migrations are destructive (e.g. "habits soft-deleted; user hard-delete cascades; migrations additive in v1"). Ties to **T5 reversibility** + **T8 idempotency**.`,
  'error-handling': `Names the failure modes that need *design* (partial failure, retries, dependency-down) **and** cites **T7** for the rest — not silence. Cheap to address, but must be named.`,
  'observability': `A feature/formula that emits them (e.g. "\`otel-bootstrap-rust\` emits traces+metrics") **or** \`excluded\` with reason.`,
  'external-integrations': `Each integration named with its shape (auth, data flow, failure mode) **or** "none." A silent integration is a hidden dependency + a secrets/abuse surface.`,
  'perf-envelope': `A concrete envelope **if** the success metric implies one (e.g. "p99 < 200ms on the streak endpoint at 100 concurrent users") **or** \`excluded\` ("v1 single-user, no perf target") — not a vibe.`,
  'abuse-surface': `For each public surface: input-validation + rate-limit stance **or** \`excluded\` ("no public/unauthenticated network surface").`
};

// SYNC: skills/vision/SKILL.md gates + vision-eval.js GATE_TOKENS. The controlled openQuestions[].context
// vocabulary; each blocking question's context STARTS WITH one of these tokens so downstream maps it.
const GATE_TOKENS = {
  'forward-coverage':                 /forward[-\s]?coverage/i,
  'reverse-trace':                    /reverse[-\s]?trace/i,
  'success-metric-oracle':            /success[-\s]?metric/i,
  'concern-decidedness':              /decidedness/i,
  'required-excluded-contradiction':  /required[-\s]?\+?[-\s]?excluded|required.{0,12}excluded|contradiction/i,
  'musthave-nongoal-contradiction':   /non[-\s]?goal|musthave[-\s]?nongoal|forbidden/i,
  'no-matching-formula':              /no[-\s]?matching[-\s]?formula|needs new formula|formula gap/i,
  'missing-product-sections':         /missing[-\s]?product[-\s]?section|empty.{0,12}section|unfilled/i
};

// SYNC: docs/DEFAULT_STACK.md "The stack" + "Stack-native formulas". Inlined so the headless
// skeleton agent resolves the stack without reading the repo. Compact, but faithful to the pins.
const DEFAULT_STACK = `Layers (copy verbatim into stack[]; "why" cites DEFAULT_STACK):
  - Core/services: Rust (all product truth, authorization, direct Postgres writes, backend glue).
  - Product surface: TypeScript + React + Vite (user-facing UI / product-surface JS).
  - Database: PostgreSQL (the truth layer; SQLite is NOT a v1 fallback).
  - Cross-language contracts: generated (TS types from Rust — ts-rs / OpenAPI; no hand-duplicated types).
  - AI/data service: Python — EXCEPTION ONLY (model-serving sidecar etc); never for tooling/truth/services/authz/glue.
  - Tests: Rust cargo test; TS vitest; Python pytest. Lint/format: Rust cargo fmt + clippy; TS biome; Python ruff.
  - Hosting: per-app, chosen at deploy time (not vision time).

Stack-native formulas — PREFER the native variant; a generic formula is a FALLBACK only when no native covers the capability:
  - Repo/workspace skeleton (Rust core): app-skeleton (generic) -> app-skeleton-rust-cargo (native)
  - Frontend skeleton:                    app-skeleton (generic) -> app-skeleton-vite-react (native)
  - CRUD entity vertical slice:           crud-feature (generic) -> crud-feature-rust (native)
  - Non-CRUD gRPC service:                (none)                 -> grpc-tonic-service
  - Closed grammar / composer version:    (none)                 -> composer-grammar-version
  - Observability bootstrap:              (misuse app-skeleton)  -> otel-bootstrap-rust
  - Audit chain:                          background-job (gen)   -> audit-chain-rust
  - Tenant-boot chokepoint:               background-job (gen)   -> tenant-boot-rust
  - OIDC auth client:                     integration-http (gen) -> oidc-client-rust
  - ReBAC authz model:                    integration-http (gen) -> openfga-model
  - IaC / cloud baseline:                 app-skeleton (gen)     -> terraform-aws-baseline
  - Schema migration:                     (shared)               -> migration (supply Rust/sqlx up/down_outline)

The off-enum tell: the generic formulas declare JS/Python enum vars. If binding a feature to a generic formula
forces an OFF-ENUM value (package_manager=cargo, language=rust, trigger_type=internal|cron), that is proof the
generic pick is wrong on this stack — switch to the native variant (defect autonomous-build-3fr.1), do NOT remap.`;

// Off-enum detector inputs (the 3fr.1 determinism check). A generic formula bound to one of these
// values is the wrong-pick signal a native variant exists for.
const GENERIC_FORMULAS = new Set(['app-skeleton', 'crud-feature', 'background-job', 'integration-http']);
const OFF_ENUM_TELLS = [
  { var: 'package_manager', val: 'cargo' },
  { var: 'language', val: 'rust' },
  { var: 'trigger_type', val: 'internal' },
  { var: 'trigger_type', val: 'cron' }
];

const PLACEHOLDER_RX = /^[.…]+$/; // "...", "…" — an unedited template ellipsis bullet.

// ===========================================================================
// Pure helpers + logic. No workflow globals, no side effects — reached by the node
// selftest via the globalThis bridge at the bottom (the runtime forbids `export` other
// than `meta`, so these are plain declarations exposed under node only).
// ===========================================================================
const isArr = Array.isArray;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const nonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;

// Pull a JSON object out of a possibly-fenced / prose-wrapped agent reply (mirrors vision-eval).
function extractJson(text) {
  if (text == null) return null;
  if (typeof text === 'object') return text;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first !== -1 && last > first) s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch { return null; }
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

function stripBullet(s) {
  return String(s).replace(/^\s*[-*]\s*(\[[ xX]?\]\s*)?/, '').trim();
}

// Mechanical emptiness backstop: a section has content if (any) entry is non-empty, non-ellipsis text.
function hasContent(v) {
  if (isArr(v)) return v.some((x) => hasContent(x));
  if (!isStr(v)) return false;
  const t = stripBullet(v);
  return t.length > 0 && !PLACEHOLDER_RX.test(t);
}

function mkBlocking(token, question) {
  return { question, blockingCompose: true, context: `${token}: ${question}` };
}

// The headless NEEDS-INPUT block: incomplete:true + a missing-product-sections openQuestion, and
// every concern marked 'underivable' (applicability derives from §3/§5/§8 — nothing to derive from).
// Matches the vision-eval oracle for the empty-product-sections fixture.
function buildNeedsInput(missing) {
  const m = isArr(missing) ? missing : [];
  return {
    status: 'needs-input',
    incomplete: true,
    missing: m,
    skeleton: null,
    applicability: Object.fromEntries(CONCERN_IDS.map((id) => [id, 'underivable'])),
    openQuestions: [
      mkBlocking('missing-product-sections',
        `Vision is missing load-bearing product section(s): ${m.join(', ')}. Fill them in vision.md and re-run /vision — /vision will not invent product content (T1).`)
    ]
  };
}

// Phase 1 verdict. Pure JS over the intake agent's raw extraction: a load-bearing section is
// "filled" only if the agent judged it real content AND it survives the mechanical backstop
// (so a wrong agent filled-flag on an "..." bullet still fails). Returns ok | needs-input | failed.
function validateIntake(raw) {
  if (!isObj(raw)) return { status: 'failed', reason: 'intake returned no object' };
  if (raw.visionExists !== true) return { status: 'failed', reason: `no vision.md found (intake.visionExists=${JSON.stringify(raw.visionExists)})` };
  const sections = isObj(raw.sections) ? raw.sections : {};
  const filled = isObj(raw.filled) ? raw.filled : {};
  const missing = [];
  for (const name of LOAD_BEARING) {
    const mechanical = hasContent(sections[name]);
    const agentFilled = filled[name] === true;
    if (!(mechanical && agentFilled)) missing.push(name);
  }
  if (missing.length) return { status: 'needs-input', missing, sections };

  // Assign stable M-ids in document order — load-bearing for coverage[] binding downstream.
  const rawMH = isArr(sections.mustHaves) ? sections.mustHaves : [];
  const mustHaves = rawMH
    .map(stripBullet)
    .filter((t) => t.length > 0 && !PLACEHOLDER_RX.test(t))
    .map((text, i) => ({ id: `M${i + 1}`, text }));
  if (!mustHaves.length) return { status: 'needs-input', missing: ['mustHaves'], sections };

  const skeleton = isObj(raw.skeleton) ? raw.skeleton : null;
  return { status: 'ok', sections, mustHaves, headless: !skeleton, skeleton };
}

// The applicability derivation table, as code (SYNC: docs/PLAN_CONCERNS.md "Applicability — and how
// it is derived"). The agent reports observable signals; THIS resolves the tier — so the derivation
// is reproducible and selftestable. data-model / error-handling / external-integrations are always
// required-to-decide; data-lifecycle / observability default optional; the other five are
// excluded-by-default and elevate to required only on a signal.
//
// ORACLE-GROUNDED (fixture 04-public-unauth-api): a §6 BUDGET line is a cost ceiling, NOT a
// secret-management signal — elevating secrets on budget there manufactures a false required+excluded
// contradiction. So secrets elevates only on authn / external-integrations / PRIVACY (not budget),
// and data-lifecycle only on privacy / PII. docs/PLAN_CONCERNS.md + skills/vision/SKILL.md still say
// "privacy/budget" for secrets — that prose should drop "budget"; tracked as a follow-up flag for /retro.
function deriveApplicability(signals) {
  const s = isObj(signals) ? signals : {};
  const sig = (k) => s[k] === true;
  const authn = (sig('impliesAccounts') || sig('multipleHumanRoles')) ? 'required' : 'excluded-by-default';
  const authz = (authn === 'required' && (sig('multiplePrincipals') || sig('crossUserData'))) ? 'required' : 'excluded-by-default';
  const secrets = (authn === 'required' || sig('externalIntegrations') || sig('privacyConstraint')) ? 'required' : 'excluded-by-default';
  const dataLifecycle = (sig('privacyConstraint') || sig('holdsPii')) ? 'required' : 'optional';
  const observability = sig('productionOperation') ? 'required' : 'optional';
  const perf = sig('scaleTarget') ? 'required' : 'excluded-by-default';
  const abuse = sig('publicSurface') ? 'required' : 'excluded-by-default';
  return {
    'data-model': 'required',
    'authn': authn,
    'authz': authz,
    'secrets': secrets,
    'data-lifecycle': dataLifecycle,
    'error-handling': 'required',
    'observability': observability,
    'external-integrations': 'required',
    'perf-envelope': perf,
    'abuse-surface': abuse
  };
}

// Applicable = required | optional. excluded-by-default concerns are NOT fanned out in Phase 3 —
// they are folded in directly as status:excluded with the standard reason (Phase 4).
function applicableConcerns(applicability) {
  const a = isObj(applicability) ? applicability : {};
  return CONCERN_IDS.filter((id) => a[id] !== 'excluded-by-default');
}

// Coerce the skeleton agent's raw output into the canonical frozen shape; collect shape errors
// (a malformed skeleton is a Phase-2 failure, not a guess to paper over — T7).
function normalizeSkeleton(raw) {
  const errors = [];
  if (!isObj(raw)) return { skeleton: null, errors: ['skeleton not an object'] };
  const app = isObj(raw.app) ? raw.app : {};
  if (!nonEmptyStr(app.name)) errors.push('app.name missing/empty');
  if (!nonEmptyStr(app.slug)) errors.push('app.slug missing/empty');

  const mustHaves = isArr(raw.mustHaves) ? raw.mustHaves : (errors.push('mustHaves must be an array'), []);
  if (isArr(raw.mustHaves) && !mustHaves.length) errors.push('mustHaves empty');
  mustHaves.forEach((m, i) => { if (!isObj(m) || !nonEmptyStr(m.id) || !nonEmptyStr(m.text)) errors.push(`mustHaves[${i}] needs {id,text}`); });

  const sm = isObj(raw.successMetric) ? raw.successMetric : (errors.push('successMetric must be an object'), {});
  if (!nonEmptyStr(sm.statement)) errors.push('successMetric.statement missing/empty');
  if (!isArr(sm.steps)) errors.push('successMetric.steps must be an array');

  if (!isObj(raw.stack)) errors.push('stack must be an object');

  const dataModel = isArr(raw.dataModel) ? raw.dataModel : (errors.push('dataModel must be an array'), []);
  dataModel.forEach((e, i) => { if (!isObj(e) || !nonEmptyStr(e.entity)) errors.push(`dataModel[${i}].entity missing`); });

  const featureOrder = isArr(raw.featureOrder) ? raw.featureOrder : (errors.push('featureOrder must be an array'), []);
  featureOrder.forEach((f, i) => {
    if (!isObj(f) || !nonEmptyStr(f.name)) errors.push(`featureOrder[${i}].name missing`);
    if (f && !isArr(f.formulas)) errors.push(`featureOrder[${i}].formulas must be an array`);
  });

  const skeleton = {
    app: { name: app.name, slug: app.slug, summary: nonEmptyStr(app.summary) ? app.summary : '' },
    mustHaves,
    successMetric: { statement: sm.statement, steps: isArr(sm.steps) ? sm.steps : [] },
    stack: isObj(raw.stack) ? raw.stack : {},
    dataModel,
    featureOrder,
    nonGoals: isArr(raw.nonGoals) ? raw.nonGoals : [],
    agentConsults: isArr(raw.agentConsults) ? raw.agentConsults : []
  };
  return { skeleton, errors };
}

// 3fr.1 determinism reference: a feature bound to a GENERIC formula whose vars carry a stack-native
// off-enum value is a wrong pick (a native variant exists). Phase 2 turns each hit into a
// no-matching-formula block carried to Phase 4. Reference check; does not resolve 3fr.1.
function detectOffEnumPicks(featureOrder) {
  const off = [];
  (isArr(featureOrder) ? featureOrder : []).forEach((f) => {
    if (!isObj(f)) return;
    const formulas = isArr(f.formulas) ? f.formulas : [];
    const generic = formulas.find((x) => GENERIC_FORMULAS.has(x));
    if (!generic) return;
    const vars = isObj(f.vars) ? f.vars : {};
    for (const tell of OFF_ENUM_TELLS) {
      const v = vars[tell.var];
      if (isStr(v) && v.toLowerCase() === tell.val) {
        off.push({ feature: f.name, formula: generic, var: tell.var, value: v });
      }
    }
  });
  return off;
}

// ---- Phase 3 (concern fan-out) pure helpers ----

// A Phase-3 ConcernResult.blockingQuestion: { question, context } whose context LEADS WITH the
// concern-decidedness gate token so Phase 4's gate 6.5 can route it (mkBlocking adds blockingCompose
// when it is promoted to an openQuestion). Reuses the agent's own context detail when it gave one.
function concernBlock(concernId, question, agentContext) {
  const detail = nonEmptyStr(agentContext) ? agentContext.replace(/^\s*concern-decidedness:\s*/i, '').trim() : '';
  return { question, context: `concern-decidedness: ${detail || question}` };
}

// A ConcernResult is DECIDED when addressed-with-evidence or excluded-with-reason; anything carrying a
// blockingQuestion (status 'failed') is UNDECIDED and trips the Phase-4 decidedness gate (T7: never silent).
function isDecided(r) {
  return isObj(r) && (r.status === 'addressed' || r.status === 'excluded');
}

// Build the per-agent inputs for the Phase-3 fan-out: ONE entry per APPLICABLE concern, each carrying
// ONLY its own CONCERN_BARS line + the shared EVIDENCE_BAR + the frozen skeleton + the read vision sections.
// excluded-by-default concerns are NOT fanned out (Phase 4 folds them in directly) — same rule applicableConcerns uses.
function concernInputs(frozen, applicability, sections) {
  return applicableConcerns(applicability).map((concernId) => ({
    concernId,
    applicability: applicability[concernId],
    concernBar: CONCERN_BARS[concernId],
    frozenSkeleton: frozen,
    visionSections: isObj(sections) ? sections : {}
  }));
}

// Coerce + validate a concern agent's reply into the canonical ConcernResult and enforce the contract the
// JSON schema cannot express: addressed REQUIRES falsifiable evidence; excluded REQUIRES a reason; an explicit
// blockingQuestion / a 'failed' / a garbled reply is undecided. The bare-assertion screen is the agent's job
// (it holds the EVIDENCE_BAR + its concernBar), but an addressed claim with NO evidence at all is downgraded
// here to undecided rather than passed silently (T7) — never let a rubber-stamp slip the gate.
function normalizeConcernResult(raw, concernId, applicability) {
  const r = isObj(raw) ? raw : {};
  const cid = nonEmptyStr(r.concernId) ? r.concernId : concernId;
  const appl = nonEmptyStr(r.applicability) ? r.applicability : applicability;
  const bq = isObj(r.blockingQuestion) ? r.blockingQuestion : null;

  // Explicit undecidable, agent-reported failure, or a blocking question -> undecided.
  if (r.status === 'failed' || (bq && nonEmptyStr(bq.question))) {
    const q = (bq && nonEmptyStr(bq.question)) ? bq.question
      : (nonEmptyStr(r.reason) ? r.reason : `concern ${cid} could not be decided from the skeleton + vision`);
    return { concernId: cid, applicability: appl, status: 'failed', blockingQuestion: concernBlock(cid, q, bq && bq.context) };
  }

  if (r.status === 'addressed') {
    if (!nonEmptyStr(r.evidence)) {
      const q = `concern ${cid} was claimed addressed with no falsifiable evidence`;
      return { concernId: cid, applicability: appl, status: 'failed', blockingQuestion: concernBlock(cid, q) };
    }
    const out = { concernId: cid, applicability: appl, status: 'addressed', evidence: r.evidence };
    if (isObj(r.coverageLink) && nonEmptyStr(r.coverageLink.mustHaveId) && isArr(r.coverageLink.features)) {
      const features = r.coverageLink.features.filter(nonEmptyStr);
      if (features.length) out.coverageLink = { mustHaveId: r.coverageLink.mustHaveId, features };
    }
    return out;
  }

  if (r.status === 'excluded') {
    if (!nonEmptyStr(r.reason)) {
      const q = `concern ${cid} was marked excluded with no reason`;
      return { concernId: cid, applicability: appl, status: 'failed', blockingQuestion: concernBlock(cid, q) };
    }
    return { concernId: cid, applicability: appl, status: 'excluded', reason: r.reason };
  }

  // Unrecognized / missing status -> undecided (never a silent drop).
  const q = `concern ${cid} returned an unrecognized status ${JSON.stringify(r.status)}`;
  return { concernId: cid, applicability: appl, status: 'failed', blockingQuestion: concernBlock(cid, q) };
}

// ===========================================================================
// Agent prompts (self-contained — the agents run in the app cwd, no repo docs).
// ===========================================================================
function intakePrompt(A) {
  return `
You are the INTAKE agent for the /vision workflow (Phase 1). You run in the APP repo's cwd. Read the human's product brief and return its sections as structured data. DO NOT invent, complete, or improve any content — report exactly what is there (T1). A section still showing the template's instructional prose, an example, or a placeholder ("...", "- [ ] ...", "What problem does this app solve?") is NOT filled.

STEPS:
1. Check whether ${JSON.stringify(A.visionPath)} exists (e.g. \`test -f ${A.visionPath} && echo yes\`). If it does NOT exist, return { "visionExists": false, "sections": {}, "filled": {} } and stop.
2. Read ${JSON.stringify(A.visionPath)}. Parse its sections by HEADING ("## N. <name>"), NOT by number, and map each heading to one of: problem, users, mustHaves, niceToHaves, nonGoals, constraints, techPreferences, successMetric, escalationBudget, anythingElse. (templates/vision.md ships 10 sections; "Success metric" is the success-metric section, "Non-goals" is non-goals — match on the title text.)
3. For mustHaves / niceToHaves / nonGoals return an ARRAY of the bullet texts (strip "- [ ]" / "-" / "*" markers; drop empty or "..." bullets). For the prose sections (problem, users, constraints, techPreferences, successMetric, escalationBudget, anythingElse) return the text as a string.
4. For EVERY section set "filled.<name>" to true ONLY if it carries real, app-specific content; false if it is empty, whitespace, "...", an unedited "- [ ] ..." bullet, or the template's instructional question / example prose.
5. ${A.skeletonPath ? `A frozen skeleton was provided at ${JSON.stringify(A.skeletonPath)} — read it and return it verbatim under "skeleton" (do NOT re-derive it).` : `No skeleton was provided (headless path) — set "skeleton": null.`}

Return ONLY the structured object (its schema is enforced).
`.trim();
}

function skeletonPrompt(intake, A) {
  const validated = JSON.stringify({ mustHaves: intake.mustHaves, sections: intake.sections }, null, 2);
  const headlessNote = intake.skeleton
    ? `A skeleton was already built by the skill shell — NORMALIZE it into the shape below; do NOT re-derive (the human already had that conversation). The provided skeleton:\n${JSON.stringify(intake.skeleton, null, 2)}`
    : `No skeleton was provided — DERIVE it headlessly from the validated vision below. There is NO human to ask.`;
  return `
You are the SKELETON agent for the /vision workflow (Phase 2). You run in the APP repo's cwd. Build the FROZEN skeleton the concern fan-out will reason against. NEVER invent product content (must-haves, users, features) to fill a gap — if a must-have has no matching formula, record a block, do not paper it (T1).

${headlessNote}

VALIDATED VISION (must-have ids already assigned — keep them VERBATIM):
${validated}

THE PINNED STACK (docs/DEFAULT_STACK.md — inlined; resolve silently, never ask, never deviate without a recorded agentConsults entry):
${DEFAULT_STACK}

PRODUCE (return ONLY the structured object; its schema is enforced):
1. app: { name, slug, summary } — name/summary from §1 + §10; slug = kebab-case of the name.
2. mustHaves: echo the ids + texts above VERBATIM (set deferred:true only if the vision itself defers a must-have).
3. successMetric: { statement: <the success-metric text>, steps: [<one observable action per step, in order>] }.
4. stack: one entry per layer from the pinned table above, each { choice, why } where "why" cites DEFAULT_STACK.
5. dataModel: [{ entity, fields:[...], relationships:[...] }] — the entities the §3 must-haves imply. Do NOT invent entities no must-have needs.
6. featureOrder: [{ name, formulas:[...], vars:{...}, mustHaveId }] — build order, deps respected (auth before per-user data). Pick the STACK-NATIVE formula variant per the map above; a generic formula (app-skeleton / crud-feature / background-job / integration-http) is a FALLBACK only when no native variant covers the capability. Honor the off-enum tell. Run \`bd formula list\` / \`bd formula show <name>\` to bind only declared var names and enum-valid values. If a must-have has NO matching formula, add { token:'no-matching-formula', note } to blocks instead of forcing a near-miss.
7. nonGoals: the non-goals (§5) array verbatim.
8. signals: report ONLY observable facts about the vision as booleans (the workflow derives concern applicability from these in PURE JS — be accurate, not generous):
   - impliesAccounts: a must-have implies user accounts / per-user data / login.
   - multipleHumanRoles: §2 lists more than one human role.
   - multiplePrincipals: more than one distinct principal (human or service) acts on data.
   - crossUserData: data is shared across or isolated between users/tenants ("only sees their own", multi-tenant).
   - privacyConstraint: a constraint states a PRIVACY / PII / compliance / data-residency rule (NOT a budget or deadline).
   - holdsPii: the data model holds personally-identifying / regulated data about real people (NOT one local user's own notes).
   - productionOperation: the success metric describes a multi-user / running-in-production flow (NOT a one-shot local CLI run).
   - externalIntegrations: the app depends on a third-party service/API (a real v1 dependency, not a nice-to-have you exclude).
   - scaleTarget: the success metric names a concrete scale / latency / throughput number.
   - publicSurface: the app exposes a public or unauthenticated network surface.
`.trim();
}

// One per APPLICABLE concern. Self-contained: the frozen skeleton, the vision sections, this concern's OWN
// bar, and the shared EVIDENCE_BAR are all inlined — the agent runs in the app cwd and cannot read any repo
// doc, and it must never see another concern's contract or another agent's output (the fan-out is the isolation).
function concernPrompt(C) {
  return `
You are the CONCERN agent for the /vision workflow (Phase 3). You decide EXACTLY ONE concern: "${C.concernId}" (applicability: ${C.applicability}). You run in the APP repo's cwd. You see ONLY this concern — you do not know how any other concern was decided and must not assume it. The FROZEN skeleton below is READ-ONLY: reason against it, never propose to change it (T10).

Decide this concern against the frozen skeleton + the vision sections. Return exactly one of:
  - status:"addressed" — the skeleton actually delivers this concern, WITH falsifiable evidence (see the bars).
  - status:"excluded"  — the concern legitimately does not apply here, WITH a one-line reason.
  - a blockingQuestion — the concern CANNOT be honestly decided from the skeleton + vision (genuinely underspecified). Do NOT guess (T1).

THIS CONCERN'S "addressed requires" CONTRACT (the ONLY concern bar that applies to you — derived from docs/PLAN_CONCERNS.md, inlined):
${C.concernBar}

THE EVIDENCE BAR (what makes "addressed" evidence falsifiable):
${EVIDENCE_BAR}

FROZEN SKELETON (read-only):
${JSON.stringify(C.frozenSkeleton, null, 2)}

VISION SECTIONS (the human's product brief — read-only context):
${JSON.stringify(C.visionSections, null, 2)}

RULES:
- "addressed" REQUIRES "evidence" meeting the bar above — cite a featureOrder[] entry by name, a formula, a numbered tenet (T#), the quality gate, or a DEFAULT_STACK pin. A BARE ASSERTION ("handled", "we use env vars", "permissions enforced") is NOT evidence and is REJECTED. If the only honest evidence would be a bare assertion, the concern is NOT addressed: mark it "excluded" with a reason, OR (if it SHOULD be addressed but no feature delivers it) return a blockingQuestion.
- "excluded" REQUIRES a one-line "reason" ("CLI tool, no network surface").
- If your "addressed" evidence cites a featureOrder[] feature that delivers a §3 must-have, ALSO emit "coverageLink": { "mustHaveId": "<the M-id>", "features": ["<feature name>"] } so reconcile can assemble coverage[].
- A blockingQuestion's "context" MUST START WITH the literal token "concern-decidedness:" so the downstream gate can route it.
- Echo "concernId":"${C.concernId}" and "applicability":"${C.applicability}" verbatim.

Return ONLY the structured object (its schema is enforced).
`.trim();
}

// ===========================================================================
// Structured-output schemas (the runtime validates the agent's reply shape).
// ===========================================================================
const INTAKE_SCHEMA = {
  type: 'object',
  required: ['visionExists', 'sections', 'filled'],
  properties: {
    visionExists: { type: 'boolean' },
    sections: {
      type: 'object',
      required: ['problem', 'mustHaves', 'successMetric'],
      properties: {
        problem: { type: 'string' },
        users: { type: 'string' },
        mustHaves: { type: 'array', items: { type: 'string' } },
        niceToHaves: { type: 'array', items: { type: 'string' } },
        nonGoals: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'string' },
        techPreferences: { type: 'string' },
        successMetric: { type: 'string' },
        escalationBudget: { type: 'string' },
        anythingElse: { type: 'string' }
      }
    },
    filled: {
      type: 'object',
      properties: Object.fromEntries(
        ['problem', 'users', 'mustHaves', 'niceToHaves', 'nonGoals', 'constraints', 'techPreferences', 'successMetric', 'escalationBudget', 'anythingElse']
          .map((k) => [k, { type: 'boolean' }])
      )
    },
    skeleton: {},
    note: { type: 'string' }
  }
};

const SKELETON_SCHEMA = {
  type: 'object',
  required: ['skeleton', 'signals'],
  properties: {
    skeleton: {
      type: 'object',
      required: ['app', 'mustHaves', 'successMetric', 'stack', 'dataModel', 'featureOrder', 'nonGoals'],
      properties: {
        app: { type: 'object', required: ['name', 'slug'], properties: { name: { type: 'string' }, slug: { type: 'string' }, summary: { type: 'string' } } },
        mustHaves: { type: 'array', items: { type: 'object', required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' }, deferred: { type: 'boolean' } } } },
        successMetric: { type: 'object', required: ['statement', 'steps'], properties: { statement: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } } },
        stack: { type: 'object' },
        dataModel: { type: 'array', items: { type: 'object', required: ['entity'], properties: { entity: { type: 'string' }, fields: { type: 'array' }, relationships: { type: 'array' } } } },
        featureOrder: { type: 'array', items: { type: 'object', required: ['name', 'formulas'], properties: { name: { type: 'string' }, formulas: { type: 'array', items: { type: 'string' } }, vars: { type: 'object' }, mustHaveId: { type: 'string' } } } },
        nonGoals: { type: 'array', items: { type: 'string' } },
        agentConsults: { type: 'array' }
      }
    },
    signals: {
      type: 'object',
      required: SIGNAL_NAMES,
      properties: Object.fromEntries(SIGNAL_NAMES.map((k) => [k, { type: 'boolean' }]))
    },
    blocks: { type: 'array', items: { type: 'object', required: ['token', 'note'], properties: { token: { type: 'string' }, note: { type: 'string' } } } }
  }
};

// Phase 3 per-concern result. status is enforced; the addressed-needs-evidence / excluded-needs-reason
// contract the schema cannot express is enforced in normalizeConcernResult (a defensive JS backstop, T7).
const CONCERN_SCHEMA = {
  type: 'object',
  required: ['concernId', 'status', 'applicability'],
  properties: {
    concernId: { type: 'string' },
    status: { type: 'string', enum: ['addressed', 'excluded', 'failed'] },
    applicability: { type: 'string' },
    evidence: { type: 'string' },
    reason: { type: 'string' },
    coverageLink: { type: 'object', required: ['mustHaveId', 'features'], properties: { mustHaveId: { type: 'string' }, features: { type: 'array', items: { type: 'string' } } } },
    blockingQuestion: { type: 'object', required: ['question', 'context'], properties: { question: { type: 'string' }, context: { type: 'string' } } }
  }
};

// ===========================================================================
// --selftest: pure-JS unit checks (NO agents). Exercises Phase-1 intake validation,
// the applicability derivation table (incl. the oracle-grounded budget-vs-secrets rule),
// skeleton normalization + freeze, and the 3fr.1 off-enum detector. Importable + runnable
// via node tests/vision/selftest.mjs.
// ===========================================================================
function runSelftest() {
  const results = [];
  const check = (name, cond) => { results.push({ name, pass: !!cond }); };

  // ---- Phase 1: validateIntake ----
  const coherentRaw = {
    visionExists: true,
    sections: {
      problem: 'Agencies juggle client work across spreadsheets and chat; nothing shows who owns what.',
      users: 'Workspace admin; Member.',
      mustHaves: ['Admins invite members; members see only their workspaces', 'Members create, assign, move tasks'],
      niceToHaves: ['Slack notifications'],
      nonGoals: ['No time tracking or invoicing'],
      constraints: 'Budget < $30/mo infra.',
      techPreferences: '',
      successMetric: 'An admin invites a member who logs in, creates a board, adds a task, and sees it in My tasks.',
      escalationBudget: '$20',
      anythingElse: 'Multi-tenant from day one.'
    },
    filled: { problem: true, users: true, mustHaves: true, niceToHaves: true, nonGoals: true, constraints: true, techPreferences: false, successMetric: true, escalationBudget: true, anythingElse: true },
    skeleton: null
  };
  const okIntake = validateIntake(coherentRaw);
  check('Phase1 accepts a coherent vision', okIntake.status === 'ok');
  check('Phase1 assigns stable M-ids in document order', okIntake.status === 'ok' && okIntake.mustHaves[0].id === 'M1' && okIntake.mustHaves[1].id === 'M2');
  check('Phase1 coherent headless run when no skeleton provided', okIntake.status === 'ok' && okIntake.headless === true);

  const emptyRaw = JSON.parse(JSON.stringify(coherentRaw));
  emptyRaw.sections.problem = 'What problem does this app solve? Who has it today?';
  emptyRaw.sections.mustHaves = ['...', '...'];
  emptyRaw.sections.successMetric = 'How will you know the app is working? One concrete observable, not a vibe.';
  emptyRaw.filled = Object.assign({}, coherentRaw.filled, { problem: false, mustHaves: false, successMetric: false });
  const niRes = validateIntake(emptyRaw);
  check('Phase1 NEEDS-INPUT on empty product sections (fixture-10 style)', niRes.status === 'needs-input');
  check('Phase1 reports all 3 load-bearing sections missing', niRes.missing.length === 3 && ['problem', 'mustHaves', 'successMetric'].every((n) => niRes.missing.includes(n)));

  const lyingRaw = JSON.parse(JSON.stringify(coherentRaw));
  lyingRaw.sections.mustHaves = ['...'];
  lyingRaw.filled.mustHaves = true; // agent wrongly claims filled
  check('Phase1 JS backstop overrides a wrong agent filled-flag', validateIntake(lyingRaw).missing.includes('mustHaves'));

  check('Phase1 fails on a missing vision file', validateIntake({ visionExists: false, sections: {}, filled: {} }).status === 'failed');

  const ni = buildNeedsInput(['mustHaves']);
  check('NEEDS-INPUT is a blocking missing-product-sections openQuestion', ni.incomplete === true && ni.openQuestions.length === 1 && ni.openQuestions[0].blockingCompose === true && /^missing-product-sections/.test(ni.openQuestions[0].context));
  check('NEEDS-INPUT marks every concern underivable', Object.keys(ni.applicability).length === CONCERN_IDS.length && Object.values(ni.applicability).every((v) => v === 'underivable'));
  check('NEEDS-INPUT context matches the GATE_TOKENS regex', GATE_TOKENS['missing-product-sections'].test(ni.openQuestions[0].context));

  // ---- deriveApplicability ----
  const none = deriveApplicability({});
  check('applicability: always-required trio', none['data-model'] === 'required' && none['error-handling'] === 'required' && none['external-integrations'] === 'required');
  check('applicability: no-signal optional pair (data-lifecycle, observability)', none['data-lifecycle'] === 'optional' && none['observability'] === 'optional');
  check('applicability: no-signal excluded-by-default five', ['authn', 'authz', 'secrets', 'perf-envelope', 'abuse-surface'].every((id) => none[id] === 'excluded-by-default'));

  const f01 = deriveApplicability({ impliesAccounts: true, multipleHumanRoles: true, multiplePrincipals: true, crossUserData: true, holdsPii: true, productionOperation: true, publicSurface: true });
  check('applicability f01: authn/authz/secrets required', f01.authn === 'required' && f01.authz === 'required' && f01.secrets === 'required');
  check('applicability f01: data-lifecycle+observability+abuse required, perf excluded', f01['data-lifecycle'] === 'required' && f01.observability === 'required' && f01['abuse-surface'] === 'required' && f01['perf-envelope'] === 'excluded-by-default');

  const f04 = deriveApplicability({ publicSurface: true, productionOperation: true }); // budget line present, but budget is not a signal
  check('applicability f04: budget-only leaves authn + secrets excluded (oracle-grounded)', f04.authn === 'excluded-by-default' && f04.secrets === 'excluded-by-default');
  check('applicability f04: public surface => abuse required', f04['abuse-surface'] === 'required');

  const f06 = deriveApplicability({ impliesAccounts: true, scaleTarget: true, publicSurface: true, productionOperation: true });
  check('applicability f06: authn required but authz excluded (single trusted group, no cross-user data)', f06.authn === 'required' && f06.authz === 'excluded-by-default');
  check('applicability f06: scale target => perf-envelope required', f06['perf-envelope'] === 'required');

  const fp = deriveApplicability({ privacyConstraint: true });
  check('applicability: privacy constraint elevates secrets + data-lifecycle without authn', fp.secrets === 'required' && fp['data-lifecycle'] === 'required');

  const appList = applicableConcerns(none);
  check('applicableConcerns drops excluded-by-default, keeps optional + required', !appList.includes('authn') && appList.includes('data-model') && appList.includes('data-lifecycle') && appList.includes('observability'));

  // ---- normalizeSkeleton + freeze ----
  const goodSkel = {
    app: { name: 'Tasklane', slug: 'tasklane', summary: 'tasks' },
    mustHaves: [{ id: 'M1', text: 'invite members' }],
    successMetric: { statement: 'admin invites, member logs in, sees task', steps: ['S1 sign in'] },
    stack: { language: { choice: 'rust', why: 'DEFAULT_STACK core' } },
    dataModel: [{ entity: 'User', fields: ['id'] }],
    featureOrder: [{ name: 'Auth', formulas: ['oidc-client-rust'], vars: {}, mustHaveId: 'M1' }],
    nonGoals: ['no invoicing']
  };
  const norm = normalizeSkeleton(goodSkel);
  check('normalizeSkeleton accepts a well-formed skeleton', norm.errors.length === 0 && norm.skeleton.app.name === 'Tasklane');
  const frozen = deepFreeze(norm.skeleton);
  check('skeleton freezes (deeply immutable)', Object.isFrozen(frozen) && Object.isFrozen(frozen.featureOrder) && Object.isFrozen(frozen.featureOrder[0]));
  let mutated = false;
  try { frozen.featureOrder.push({ name: 'x' }); } catch { mutated = true; }
  check('frozen skeleton rejects mutation', mutated || frozen.featureOrder.length === 1);

  const badSkel = JSON.parse(JSON.stringify(goodSkel)); delete badSkel.featureOrder;
  check('normalizeSkeleton flags a malformed skeleton (missing featureOrder)', normalizeSkeleton(badSkel).errors.length > 0);

  // ---- detectOffEnumPicks (3fr.1) ----
  check('detectOffEnumPicks flags a generic formula bound off-enum (package_manager=cargo)', detectOffEnumPicks([{ name: 'Core', formulas: ['app-skeleton'], vars: { package_manager: 'cargo' } }]).length === 1);
  check('detectOffEnumPicks passes a stack-native pick', detectOffEnumPicks([{ name: 'Core', formulas: ['app-skeleton-rust-cargo'], vars: { package_manager: 'cargo' } }]).length === 0);

  // ---- Phase 3: CONCERN_BARS sync + concern fan-out plumbing ----
  check('CONCERN_BARS has one non-empty bar per CONCERN_ID (SYNC with PLAN_CONCERNS.md)',
    CONCERN_IDS.every((id) => nonEmptyStr(CONCERN_BARS[id])));
  check('CONCERN_BARS carries no concern outside the vocabulary',
    Object.keys(CONCERN_BARS).every((id) => CONCERN_IDS.includes(id)) && Object.keys(CONCERN_BARS).length === CONCERN_IDS.length);

  // concernInputs: one input per APPLICABLE concern, each with ONLY its own bar; excluded-by-default dropped.
  const ci = concernInputs(frozen, none, coherentRaw.sections);
  check('concernInputs yields one input per applicable concern (excludes excluded-by-default)',
    ci.length === applicableConcerns(none).length && !ci.some((i) => i.concernId === 'authn') && ci.some((i) => i.concernId === 'data-model'));
  check('each concern input carries ONLY its own bar + the frozen skeleton',
    ci.every((i) => i.concernBar === CONCERN_BARS[i.concernId] && i.frozenSkeleton === frozen));

  // concernPrompt: self-contained (inlines this concern's bar + the EVIDENCE_BAR + the skeleton); never tells
  // the agent to read a repo doc by relative path; instructs the concern-decidedness block token.
  const cPrompt = concernPrompt(ci.find((i) => i.concernId === 'data-model'));
  check('concernPrompt inlines this concern bar + EVIDENCE_BAR + skeleton (self-contained)',
    cPrompt.includes(CONCERN_BARS['data-model']) && cPrompt.includes('falsifiable') && cPrompt.includes('Tasklane'));
  check('concernPrompt never instructs reading PLAN_CONCERNS.md / vision.spec.md by relative path',
    !/Read .*PLAN_CONCERNS\.md/i.test(cPrompt) && !cPrompt.includes('vision.spec.md'));
  check('concernPrompt instructs the concern-decidedness block token',
    cPrompt.includes('concern-decidedness:'));

  // normalizeConcernResult: the contract the schema can't express.
  const addr = normalizeConcernResult({ concernId: 'data-model', status: 'addressed', evidence: 'User entity in Data model with fields', applicability: 'required', coverageLink: { mustHaveId: 'M1', features: ['Auth'] } }, 'data-model', 'required');
  check('normalize: addressed+evidence is decided and keeps coverageLink',
    addr.status === 'addressed' && isDecided(addr) && addr.coverageLink.mustHaveId === 'M1' && addr.coverageLink.features[0] === 'Auth');
  const bareAddr = normalizeConcernResult({ concernId: 'authn', status: 'addressed', applicability: 'required' }, 'authn', 'required');
  check('normalize: addressed WITHOUT evidence downgrades to undecided (no silent rubber-stamp, T7)',
    bareAddr.status === 'failed' && !isDecided(bareAddr) && /^concern-decidedness:/.test(bareAddr.blockingQuestion.context));
  const excl = normalizeConcernResult({ concernId: 'abuse-surface', status: 'excluded', reason: 'no public surface', applicability: 'required' }, 'abuse-surface', 'required');
  check('normalize: excluded+reason is decided', excl.status === 'excluded' && isDecided(excl) && excl.reason === 'no public surface');
  const exclNoReason = normalizeConcernResult({ concernId: 'secrets', status: 'excluded', applicability: 'required' }, 'secrets', 'required');
  check('normalize: excluded WITHOUT reason downgrades to undecided', exclNoReason.status === 'failed' && !isDecided(exclNoReason));
  const blocked = normalizeConcernResult({ concernId: 'authz', status: 'addressed', blockingQuestion: { question: 'who owns whose data?', context: 'underspecified' }, applicability: 'required' }, 'authz', 'required');
  check('normalize: a blockingQuestion is undecided and its context leads with the gate token',
    blocked.status === 'failed' && /^concern-decidedness:/.test(blocked.blockingQuestion.context) && GATE_TOKENS['concern-decidedness'].test(blocked.blockingQuestion.context));
  const garbled = normalizeConcernResult('not an object', 'observability', 'optional');
  check('normalize: a garbled / unrecognized reply is undecided, never dropped (T7)',
    garbled.status === 'failed' && garbled.concernId === 'observability' && !isDecided(garbled));

  // concernBlock: context always leads with the token (reuses agent detail when present).
  check('concernBlock leads with the concern-decidedness token and reuses agent context detail',
    concernBlock('x', 'q?', 'concern-decidedness: needs an IdP').context === 'concern-decidedness: needs an IdP' &&
    concernBlock('x', 'q?').context === 'concern-decidedness: q?');

  // Fan-out shape (the bead's "Verify"): one DECIDED record per applicable concern when every agent answers well.
  const fakeReplies = ci.map((i) => i.concernId === 'data-model'
    ? { concernId: i.concernId, status: 'addressed', evidence: 'User entity in Data model', applicability: i.applicability }
    : { concernId: i.concernId, status: 'excluded', reason: `not applicable to ${i.concernId}`, applicability: i.applicability });
  const fanned = ci.map((i, k) => normalizeConcernResult(fakeReplies[k], i.concernId, i.applicability));
  check('fan-out yields exactly one record per applicable concern, all decided',
    fanned.length === ci.length && fanned.every(isDecided) && new Set(fanned.map((r) => r.concernId)).size === ci.length);

  const passed = results.filter((r) => r.pass).length;
  return { results, passed, total: results.length, ok: passed === results.length };
}

// ===========================================================================
// Orchestration (agents). Guarded so the module is node-importable for selftest.
// ih5.2 runs Phases 1-2 only; ih5.3/ih5.4 append the concern fan-out + reconcile/assemble.
// ===========================================================================
async function main() {
  const A = parsedArgs;
  log(`vision starting — vision=${A.visionPath}${A.skeletonPath ? ` skeleton=${A.skeletonPath}` : ' (headless skeleton)'}${A.dryRun ? ' [dry-run]' : ''}`);

  // ---- Phase 1: intake + validate ----
  phase('Intake');
  const intakeRaw = await agent(intakePrompt(A), { label: 'intake', phase: 'Intake', schema: INTAKE_SCHEMA });
  const intake = validateIntake(intakeRaw);
  if (intake.status === 'failed') {
    log(`vision: FAILED — ${intake.reason}`);
    return { status: 'failed', reason: intake.reason };
  }
  if (intake.status === 'needs-input') {
    log(`vision: NEEDS-INPUT — unfilled load-bearing section(s): ${intake.missing.join(', ')}. Fill vision.md and re-run.`);
    return buildNeedsInput(intake.missing);
  }
  log(`vision: intake ok — ${intake.mustHaves.length} must-have(s), headless=${intake.headless}`);

  // ---- Phase 2: skeleton + applicability ----
  phase('Skeleton');
  const skelRaw = await agent(skeletonPrompt(intake, A), { label: 'skeleton', phase: 'Skeleton', schema: SKELETON_SCHEMA });
  const { skeleton, errors } = normalizeSkeleton(skelRaw && skelRaw.skeleton);
  if (errors.length) {
    log(`vision: FAILED — skeleton malformed: ${errors.slice(0, 6).join('; ')}`);
    return { status: 'failed', reason: 'skeleton malformed', errors };
  }
  const applicability = deriveApplicability(skelRaw && skelRaw.signals);
  const frozen = deepFreeze(skeleton);

  // Carry Phase-2 blocks (no-matching-formula etc) forward to Phase 4 (do not stop here — T7).
  const blocks = isArr(skelRaw && skelRaw.blocks) ? skelRaw.blocks.slice() : [];
  for (const o of detectOffEnumPicks(frozen.featureOrder)) {
    blocks.push({ token: 'no-matching-formula', note: `feature "${o.feature}" binds generic formula ${o.formula} with off-enum ${o.var}=${o.value} — pick the stack-native variant (DEFAULT_STACK §Stack-native formulas; defect autonomous-build-3fr.1).` });
  }

  const applicable = applicableConcerns(applicability);
  log(`vision: skeleton frozen — ${frozen.featureOrder.length} feature(s), ${applicable.length}/${CONCERN_IDS.length} concern(s) applicable${blocks.length ? `, ${blocks.length} carried block(s)` : ''}.`);

  // ---- Phase 3: concern fan-out (1 agent per applicable concern, parallel over the frozen skeleton) ----
  // Each agent decides ONE concern against the frozen skeleton with ONLY its own concernBar; the runtime
  // fan-out is the isolation (no agent sees another's contract or output). excluded-by-default concerns are
  // NOT spawned — Phase 4 folds them in directly. Any error/skip becomes a 'failed' (undecided) result, never
  // a silent drop (T7): a thunk that rejects is caught here; a user-skip (null) is backfilled in the map.
  phase('Concerns');
  const inputs = concernInputs(frozen, applicability, intake.sections);
  log(`vision: fanning out ${inputs.length} concern agent(s): ${inputs.map((i) => i.concernId).join(', ') || '(none)'}`);
  const concerns = (await parallel(inputs.map((C) => () =>
    agent(concernPrompt(C), { label: `concern:${C.concernId}`, phase: 'Concerns', schema: CONCERN_SCHEMA })
      .then((raw) => normalizeConcernResult(raw, C.concernId, C.applicability))
      .catch((e) => ({
        concernId: C.concernId, applicability: C.applicability, status: 'failed',
        blockingQuestion: concernBlock(C.concernId, `concern ${C.concernId} agent errored: ${(e && e.message) ? e.message : String(e)}`)
      }))
  ))).map((r, i) => r || ({
    concernId: inputs[i].concernId, applicability: inputs[i].applicability, status: 'failed',
    blockingQuestion: concernBlock(inputs[i].concernId, `concern ${inputs[i].concernId} agent returned no result (skipped)`)
  }));

  const undecided = concerns.filter((r) => !isDecided(r));
  log(`vision: concerns decided — ${concerns.length - undecided.length}/${concerns.length} decided${undecided.length ? `, ${undecided.length} undecided (concern-decidedness): ${undecided.map((r) => r.concernId).join(', ')}` : ''}.`);

  // Phase 4 (reconcile: fold in excluded-by-default concerns + the four gates + decidedness verdict +
  // assemble lock v2/tenets/plan.md) is appended by autonomous-build-ih5.4. ih5.3 returns the frozen skeleton
  // + applicability + the per-concern fan-out results so the seam is exercisable end-to-end now. `incomplete`
  // here is NOT the final verdict — Phase 4 computes it from these blocking questions + the coverage gates.
  return {
    status: 'ok',
    skeleton: frozen,
    signals: skelRaw && skelRaw.signals,
    applicability,
    applicableConcerns: applicable,
    concerns,
    blocks,
    incomplete: false, // placeholder — Phase 4 (ih5.4) sets the real verdict from concerns[] + the gates.
    note: 'Phases 1-3 (autonomous-build-ih5.3); reconcile + decidedness verdict + assemble land in ih5.4.'
  };
}

// Entry point — guarded so `node`/`import` (for the selftest harness) never triggers agent calls.
if (typeof agent === 'function') {
  if (parsedArgs.selftest) {
    const r = runSelftest();
    log(`vision --selftest: ${r.passed}/${r.total} checks passed${r.ok ? '' : ' — FAILURES:'}`);
    for (const c of r.results) if (!c.pass) log(`  FAIL: ${c.name}`);
  } else {
    await main();
  }
} else {
  // node-only bridge: the runtime forbids `export` other than `meta`, so the pure checkers can't be
  // ESM-exported. Under node (`agent` undefined) we expose them on globalThis for tests/vision/selftest.mjs.
  globalThis.__vision = {
    extractJson, deepFreeze, hasContent, stripBullet, mkBlocking,
    validateIntake, buildNeedsInput, deriveApplicability, applicableConcerns,
    normalizeSkeleton, detectOffEnumPicks, runSelftest,
    concernBlock, isDecided, concernInputs, normalizeConcernResult,
    intakePrompt, skeletonPrompt, concernPrompt, parseArgs,
    CONCERN_IDS, CONCERN_BARS, EVIDENCE_BAR, GATE_TOKENS, DEFAULT_STACK, SIGNAL_NAMES, LOAD_BEARING,
    INTAKE_SCHEMA, SKELETON_SCHEMA, CONCERN_SCHEMA
  };
}
