#!/usr/bin/env node
/**
 * nSpec CLI — agent-friendly interface for spec-driven development.
 *
 * Commands:
 *   nspec init <name>
 *   nspec generate <name> <stage> [--description "..."]
 *   nspec verify <name> [--scheme audit|cove|committee]
 *   nspec cascade <name> [--from <stage>]
 *   nspec status [name]
 *   nspec refine <name> <stage> --feedback "..."
 *
 * Env:
 *   NSPEC_API_KEY   — OpenAI or Anthropic API key (required for generate/verify/cascade/refine)
 *   NSPEC_API_BASE  — Base URL (default: https://api.openai.com/v1)
 *   NSPEC_MODEL     — Model ID (default: gpt-4o)
 *   NSPEC_SPECS_DIR — Specs folder (default: .specs relative to cwd)
 */

import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const store = require('../out/core/specStore.js');
const prompts = require('../out/core/prompts.js');

// ── Config ───────────────────────────────────────────────────────────────────

const API_KEY    = process.env.NSPEC_API_KEY || '';
const BASE_URL   = (process.env.NSPEC_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL      = process.env.NSPEC_MODEL || 'gpt-4o';
const IS_ANTHROPIC = BASE_URL.includes('anthropic') || API_KEY.startsWith('sk-ant');
const SPECS_DIR  = process.env.NSPEC_SPECS_DIR || path.join(process.cwd(), '.specs');

// ── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

function getPositional(index) {
  // Return the arg at position, skipping --flag pairs
  let pos = 0;
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) { i++; continue; } // skip flag + value
    if (pos === index) return args[i];
    pos++;
  }
  return null;
}

const specsDir = getArg('--specs-dir') || SPECS_DIR;

// ── API caller ───────────────────────────────────────────────────────────────

function requireApiKey() {
  if (!API_KEY) {
    console.error('Error: NSPEC_API_KEY env var is required for this command.');
    process.exit(1);
  }
}

async function callLLM(systemPrompt, userPrompt) {
  const start = Date.now();
  const result = IS_ANTHROPIC
    ? await callAnthropic(systemPrompt, userPrompt)
    : await callOpenAI(systemPrompt, userPrompt);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  process.stderr.write(`  (${elapsed}s)\n`);
  return result;
}

async function callOpenAI(systemPrompt, userPrompt) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

async function callAnthropic(systemPrompt, userPrompt) {
  const res = await fetch(`${BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return json.content?.map(b => b.text).join('') || '';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseHealthScore(text) {
  const m = text.match(/(?:Health|Final)\s*Score[:\s]+([\d]+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function countUncovered(text) { return (text.match(/UNCOVERED/gi) || []).length; }

function buildPromptContext(specName) {
  const specConfig = store.readConfig(specsDir, specName);
  const wsConfig = store.loadWorkspaceConfig(specsDir);
  const requirementsFormat =
    specConfig?.requirementsFormat ?? wsConfig?.requirementsFormat ?? undefined;
  return {
    title: specName,
    role: store.loadRole(specsDir, specName) || undefined,
    steering: store.loadSteering(specsDir, specName) || undefined,
    extraSections: [],
    requirementsFormat,
  };
}

function getWorkspaceContext(specName, stage) {
  // Only inject workspace context for design and tasks stages
  if (stage !== 'design' && stage !== 'tasks') return '';
  return store.buildWorkspaceContext(process.cwd(), specName);
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdInit() {
  const name = getPositional(0);
  if (!name) { console.error('Usage: nspec init <name> [--type bugfix] [--mode design-first] [--template rest-api] [--format ears]'); process.exit(1); }
  const folderName = store.toFolderName(name);

  const specType = getArg('--type');
  const modeArg = getArg('--mode');
  const templateArg = getArg('--template');
  const formatArg = getArg('--format');

  // Validate --format flag
  if (formatArg && formatArg !== 'ears' && formatArg !== 'given-when-then') {
    console.error('Error: --format must be "ears" or "given-when-then".');
    process.exit(1);
  }

  // Determine generation mode
  let mode = 'requirements-first';
  if (specType === 'bugfix') mode = 'bugfix';
  else if (modeArg === 'design-first') mode = 'design-first';

  // Validate template if provided
  if (templateArg && !store.AVAILABLE_TEMPLATES.includes(templateArg)) {
    console.error(`Error: unknown template "${templateArg}". Available: ${store.AVAILABLE_TEMPLATES.join(', ')}`);
    process.exit(1);
  }

  const dir = store.createSpecFolder(specsDir, folderName, mode, templateArg || undefined);

  // Persist requirements format to spec config if specified
  if (formatArg) {
    const existing = store.readConfig(specsDir, folderName);
    if (existing) {
      existing.requirementsFormat = formatArg;
      store.writeSpecConfig(specsDir, folderName, existing);
    }
  }

  // Scaffold template files if a template was selected
  if (templateArg) {
    store.scaffoldTemplate(specsDir, folderName, templateArg);
    const info = store.getTemplateInfo(templateArg);
    console.log(`Template: ${info?.name || templateArg}`);
  }

  if (mode === 'bugfix') {
    console.log(`Bugfix spec created: ${dir}`);
    console.log('Pipeline: root-cause → fix-design → regression-tasks → verify');
  } else if (mode === 'design-first') {
    console.log(`Design-first spec created: ${dir}`);
    console.log('Pipeline: design → (backfill) requirements → tasks → verify');
  } else {
    console.log(dir);
  }
}

async function cmdGenerate() {
  requireApiKey();
  const name = getPositional(0);
  const stage = getPositional(1);
  if (!name || !stage || !store.ALL_STAGES.includes(stage)) {
    console.error('Usage: nspec generate <name> <stage> [--description "..."] [--format ears|given-when-then]');
    console.error('Stages: requirements, design, tasks, verify');
    process.exit(1);
  }

  const folderName = store.toFolderName(name);
  const description = getArg('--description');
  const formatArg = getArg('--format');

  // Validate --format flag
  if (formatArg && formatArg !== 'ears' && formatArg !== 'given-when-then') {
    console.error('Error: --format must be "ears" or "given-when-then".');
    process.exit(1);
  }

  // Persist format to spec config if explicitly set via --format
  if (formatArg && stage === 'requirements') {
    const existing = store.readConfig(specsDir, folderName);
    if (existing) {
      existing.requirementsFormat = formatArg;
      store.writeSpecConfig(specsDir, folderName, existing);
    }
  }

  const ctx = buildPromptContext(folderName);

  // CLI flag overrides config for this run
  if (formatArg && stage === 'requirements') {
    ctx.requirementsFormat = formatArg;
  }

  // Load extra sections if present
  ctx.extraSections = store.loadExtraSections(specsDir, folderName, stage);

  // Check for custom prompt override
  const customPrompt = store.loadCustomPrompt(specsDir, folderName, stage);

  let systemPrompt;
  let userPrompt;

  if (stage === 'verify') {
    const req = store.readStage(specsDir, folderName, 'requirements');
    const des = store.readStage(specsDir, folderName, 'design');
    const tasks = store.readStage(specsDir, folderName, 'tasks');
    if (!req || !des || !tasks) {
      console.error('Error: verify requires requirements, design, and tasks stages to exist.');
      process.exit(1);
    }
    systemPrompt = customPrompt || prompts.buildSystemPrompt('verify', ctx);
    userPrompt = prompts.buildVerificationPrompt(req, des, tasks);
  } else if (stage === 'requirements') {
    if (!description) {
      console.error('Error: --description required for requirements stage.');
      process.exit(1);
    }
    if (ctx.requirementsFormat === 'ears') {
      process.stderr.write('  (EARS format) ');
    }
    systemPrompt = customPrompt || prompts.buildSystemPrompt('requirements', ctx);
    userPrompt = description;
  } else if (stage === 'design') {
    const req = store.readStage(specsDir, folderName, 'requirements');
    if (!req) { console.error('Error: requirements stage must exist before design.'); process.exit(1); }
    systemPrompt = customPrompt || prompts.buildSystemPrompt('design', ctx);
    const wsContext = getWorkspaceContext(folderName, stage);
    userPrompt = wsContext ? `${req}\n\n${wsContext}` : req;
  } else if (stage === 'tasks') {
    const des = store.readStage(specsDir, folderName, 'design');
    if (!des) { console.error('Error: design stage must exist before tasks.'); process.exit(1); }
    systemPrompt = customPrompt || prompts.buildSystemPrompt('tasks', ctx);
    const wsContext = getWorkspaceContext(folderName, stage);
    userPrompt = wsContext ? `${des}\n\n${wsContext}` : des;
  }

  // Cross-spec context injection
  const contextSpec = getArg('--context');
  if (contextSpec && stage !== 'verify') {
    const contextName = store.toFolderName(contextSpec);
    const crossContext = store.loadCrossSpecContext(specsDir, contextName);
    if (crossContext) {
      userPrompt = `${userPrompt}\n\n${crossContext}`;
      process.stderr.write(`  (with context from ${contextName}) `);
    }
  }

  // Inject vibeContext for vibe-originated specs (design/tasks stages)
  if (stage === 'design' || stage === 'tasks') {
    const vibeCtx = store.loadVibeContext(specsDir, folderName);
    if (vibeCtx?.extractedDescription) {
      userPrompt = `${userPrompt}\n\n## Conversation Context\n${vibeCtx.extractedDescription}`;
    }
  }

  process.stderr.write(`  Generating ${stage}...`);
  const result = await callLLM(systemPrompt, userPrompt);
  store.writeStage(specsDir, folderName, stage, result);

  if (stage === 'tasks') {
    store.syncProgressFromMarkdown(specsDir, folderName, result);
  }

  if (stage === 'verify') {
    const score = parseHealthScore(result);
    const uncovered = countUncovered(result);
    console.log(`Health Score: ${score ?? '?'}/100 | Uncovered: ${uncovered}`);
  } else {
    console.log(`Wrote ${stage}.md`);
  }
}

async function cmdVerify() {
  requireApiKey();
  const name = getPositional(0);
  if (!name) { console.error('Usage: nspec verify <name> [--scheme audit|cove|committee]'); process.exit(1); }

  const folderName = store.toFolderName(name);
  const scheme = getArg('--scheme') || 'audit';
  if (!['audit', 'cove', 'committee'].includes(scheme)) {
    console.error('Error: --scheme must be audit, cove, or committee');
    process.exit(1);
  }

  const req = store.readStage(specsDir, folderName, 'requirements');
  const des = store.readStage(specsDir, folderName, 'design');
  const tasks = store.readStage(specsDir, folderName, 'tasks');
  if (!req || !des || !tasks) {
    console.error('Error: requirements, design, and tasks stages must exist before verify.');
    process.exit(1);
  }

  const ctx = buildPromptContext(folderName);
  let result;

  if (scheme === 'audit') {
    process.stderr.write('  Verifying (audit)...');
    const sys = prompts.buildSystemPrompt('verify', ctx);
    const user = prompts.buildVerificationPrompt(req, des, tasks);
    result = await callLLM(sys, user);
  } else if (scheme === 'cove') {
    process.stderr.write('  CoVe questions...');
    const qSys = prompts.buildCoveQuestionsSystem(ctx);
    const qUser = prompts.buildCoveQuestionsUserPrompt(req, des, tasks);
    const questions = await callLLM(qSys, qUser);

    process.stderr.write('  CoVe verdict...');
    const vSys = prompts.buildCoveVerdictSystem(ctx);
    const vUser = prompts.buildCoveVerdictUserPrompt(req, des, tasks, questions);
    result = await callLLM(vSys, vUser);
  } else {
    // committee
    process.stderr.write('  Audit + CoVe questions (parallel)...');
    const auditSys = prompts.buildSystemPrompt('verify', ctx);
    const auditUser = prompts.buildVerificationPrompt(req, des, tasks);
    const qSys = prompts.buildCoveQuestionsSystem(ctx);
    const qUser = prompts.buildCoveQuestionsUserPrompt(req, des, tasks);

    const [auditResult, questions] = await Promise.all([
      callLLM(auditSys, auditUser),
      callLLM(qSys, qUser),
    ]);

    process.stderr.write('  CoVe verdict...');
    const vSys = prompts.buildCoveVerdictSystem(ctx);
    const vUser = prompts.buildCoveVerdictUserPrompt(req, des, tasks, questions);
    const coveVerdict = await callLLM(vSys, vUser);

    process.stderr.write('  Committee synthesis...');
    const cSys = prompts.buildCommitteeSystem(ctx);
    const cUser = prompts.buildCommitteeUserPrompt(auditResult, coveVerdict);
    result = await callLLM(cSys, cUser);
  }

  store.writeStage(specsDir, folderName, 'verify', result);

  const score = parseHealthScore(result);
  const uncovered = countUncovered(result);
  console.log(`Health Score: ${score ?? '?'}/100 | Uncovered: ${uncovered} | Scheme: ${scheme}`);
}

const PIPELINE_ORDER = ['requirements', 'design', 'tasks', 'verify'];

async function cmdCascade() {
  requireApiKey();
  const name = getPositional(0);
  if (!name) { console.error('Usage: nspec cascade <name> [--from <stage>]'); process.exit(1); }

  const folderName = store.toFolderName(name);
  const from = getArg('--from') || 'design';
  const scheme = getArg('--scheme') || 'audit';
  const contextSpec = getArg('--context');
  let crossContext = '';
  if (contextSpec) {
    const contextName = store.toFolderName(contextSpec);
    crossContext = store.loadCrossSpecContext(specsDir, contextName) || '';
    if (crossContext) console.log(`  Including context from: ${contextName}`);
  }

  if (!PIPELINE_ORDER.includes(from)) {
    console.error(`Error: --from must be one of: ${PIPELINE_ORDER.join(', ')}`);
    process.exit(1);
  }

  const ctx = buildPromptContext(folderName);
  const startIdx = PIPELINE_ORDER.indexOf(from);

  // Load vibeContext once — if the spec was created via vibe-to-spec, inject
  // the extracted conversation description into design/tasks prompts.
  const vibeCtx = store.loadVibeContext(specsDir, folderName);
  const vibeAppend = vibeCtx?.extractedDescription
    ? `\n\n## Conversation Context\n${vibeCtx.extractedDescription}`
    : '';

  console.log(`Cascading: ${PIPELINE_ORDER.slice(startIdx).join(' -> ')}`);

  for (let i = startIdx; i < PIPELINE_ORDER.length; i++) {
    const stage = PIPELINE_ORDER[i];
    ctx.extraSections = store.loadExtraSections(specsDir, folderName, stage);
    const customPrompt = store.loadCustomPrompt(specsDir, folderName, stage);

    if (stage === 'requirements') {
      // Cannot regenerate requirements without description — skip
      if (!store.readStage(specsDir, folderName, 'requirements')) {
        console.error('Error: requirements must already exist to cascade from design.');
        process.exit(1);
      }
      continue;
    }

    if (stage === 'design') {
      const req = store.readStage(specsDir, folderName, 'requirements');
      if (!req) { console.error('Error: requirements must exist.'); process.exit(1); }
      process.stderr.write('  Generating design...');
      const sys = customPrompt || prompts.buildSystemPrompt('design', ctx);
      const wsContext = getWorkspaceContext(folderName, stage);
      let userContent = wsContext ? `${req}\n\n${wsContext}` : req;
      if (crossContext) userContent = `${userContent}\n\n${crossContext}`;
      if (vibeAppend) userContent = `${userContent}${vibeAppend}`;
      const result = await callLLM(sys, userContent);
      store.writeStage(specsDir, folderName, 'design', result);
      console.log('  Wrote design.md');
    } else if (stage === 'tasks') {
      const des = store.readStage(specsDir, folderName, 'design');
      if (!des) { console.error('Error: design must exist.'); process.exit(1); }
      process.stderr.write('  Generating tasks...');
      const sys = customPrompt || prompts.buildSystemPrompt('tasks', ctx);
      const wsContext = getWorkspaceContext(folderName, stage);
      let userContent = wsContext ? `${des}\n\n${wsContext}` : des;
      if (crossContext) userContent = `${userContent}\n\n${crossContext}`;
      if (vibeAppend) userContent = `${userContent}${vibeAppend}`;
      const result = await callLLM(sys, userContent);
      store.writeStage(specsDir, folderName, 'tasks', result);
      store.syncProgressFromMarkdown(specsDir, folderName, result);
      console.log('  Wrote tasks.md');
    } else if (stage === 'verify') {
      const req = store.readStage(specsDir, folderName, 'requirements');
      const des = store.readStage(specsDir, folderName, 'design');
      const tasks = store.readStage(specsDir, folderName, 'tasks');
      if (!req || !des || !tasks) {
        console.error('Error: all three stages must exist for verify.');
        process.exit(1);
      }
      process.stderr.write(`  Verifying (${scheme})...`);
      const sys = customPrompt || prompts.buildSystemPrompt('verify', ctx);
      const user = prompts.buildVerificationPrompt(req, des, tasks);
      const result = await callLLM(sys, user);
      store.writeStage(specsDir, folderName, 'verify', result);

      const score = parseHealthScore(result);
      const uncovered = countUncovered(result);
      console.log(`  Health Score: ${score ?? '?'}/100 | Uncovered: ${uncovered}`);
    }
  }

  console.log('Cascade complete.');
}

// ── Backfill command (design-first: reverse-generate requirements from design) ──

async function cmdBackfill() {
  requireApiKey();
  const name = getPositional(0);
  const target = getPositional(1);
  if (!name || target !== 'requirements') {
    console.error('Usage: nspec backfill <name> requirements');
    console.error('Reverse-generates requirements from an existing design document.');
    process.exit(1);
  }

  const folderName = store.toFolderName(name);
  const design = store.readStage(specsDir, folderName, 'design');
  if (!design) {
    console.error('Error: design.md must exist to backfill requirements.');
    process.exit(1);
  }

  const ctx = buildPromptContext(folderName);
  ctx.extraSections = store.loadExtraSections(specsDir, folderName, 'requirements');
  const customPrompt = store.loadCustomPrompt(specsDir, folderName, 'requirements');

  const systemPrompt = customPrompt || prompts.buildRequirementsFromDesignPrompt(ctx);

  process.stderr.write('  Backfilling requirements from design...');
  const result = await callLLM(systemPrompt, design);
  store.writeStage(specsDir, folderName, 'requirements', result);
  console.log('Wrote requirements.md (backfilled from design)');
}

// ── Bugfix pipeline commands ────────────────────────────────────────────────

const BUGFIX_PIPELINE = ['root-cause', 'fix-design', 'regression-tasks', 'verify'];

async function cmdBugfixGenerate() {
  requireApiKey();
  const name = getPositional(0);
  const stage = getPositional(1);
  if (!name || !stage || !BUGFIX_PIPELINE.includes(stage)) {
    console.error('Usage: nspec bugfix-generate <name> <stage> [--description "..."]');
    console.error('Stages: root-cause, fix-design, regression-tasks, verify');
    process.exit(1);
  }

  const folderName = store.toFolderName(name);
  const description = getArg('--description');
  const ctx = buildPromptContext(folderName);

  let systemPrompt;
  let userPrompt;

  if (stage === 'root-cause') {
    if (!description) {
      console.error('Error: --description required for root-cause stage (bug report).');
      process.exit(1);
    }
    systemPrompt = prompts.buildBugfixPrompt('root-cause', ctx);
    userPrompt = description;
  } else if (stage === 'fix-design') {
    const rc = store.readBugfixStage(specsDir, folderName, 'root-cause');
    if (!rc) { console.error('Error: root-cause must exist before fix-design.'); process.exit(1); }
    systemPrompt = prompts.buildBugfixPrompt('fix-design', ctx);
    userPrompt = rc;
  } else if (stage === 'regression-tasks') {
    const rc = store.readBugfixStage(specsDir, folderName, 'root-cause');
    const fd = store.readBugfixStage(specsDir, folderName, 'fix-design');
    if (!rc || !fd) { console.error('Error: root-cause and fix-design must exist before regression-tasks.'); process.exit(1); }
    systemPrompt = prompts.buildBugfixPrompt('regression-tasks', ctx);
    userPrompt = `## ROOT CAUSE\n${rc}\n\n## FIX DESIGN\n${fd}`;
  } else if (stage === 'verify') {
    const rc = store.readBugfixStage(specsDir, folderName, 'root-cause');
    const fd = store.readBugfixStage(specsDir, folderName, 'fix-design');
    const rt = store.readBugfixStage(specsDir, folderName, 'regression-tasks');
    if (!rc || !fd || !rt) {
      console.error('Error: all three bugfix stages must exist for verify.');
      process.exit(1);
    }
    systemPrompt = prompts.buildBugfixPrompt('verify', ctx);
    userPrompt = prompts.buildBugfixVerificationPrompt(rc, fd, rt);
  }

  process.stderr.write(`  Generating ${stage}...`);
  const result = await callLLM(systemPrompt, userPrompt);
  store.writeBugfixStage(specsDir, folderName, stage, result);

  if (stage === 'verify') {
    const score = parseHealthScore(result);
    console.log(`Health Score: ${score ?? '?'}/100`);
  } else {
    console.log(`Wrote ${stage}.md`);
  }
}

async function cmdBugfixCascade() {
  requireApiKey();
  const name = getPositional(0);
  if (!name) { console.error('Usage: nspec bugfix-cascade <name> [--from <stage>]'); process.exit(1); }

  const folderName = store.toFolderName(name);
  const from = getArg('--from') || 'fix-design';

  if (!BUGFIX_PIPELINE.includes(from)) {
    console.error(`Error: --from must be one of: ${BUGFIX_PIPELINE.join(', ')}`);
    process.exit(1);
  }

  const ctx = buildPromptContext(folderName);
  const startIdx = BUGFIX_PIPELINE.indexOf(from);

  console.log(`Cascading bugfix: ${BUGFIX_PIPELINE.slice(startIdx).join(' -> ')}`);

  for (let i = startIdx; i < BUGFIX_PIPELINE.length; i++) {
    const stage = BUGFIX_PIPELINE[i];

    if (stage === 'root-cause') {
      if (!store.readBugfixStage(specsDir, folderName, 'root-cause')) {
        console.error('Error: root-cause must already exist to cascade.');
        process.exit(1);
      }
      continue;
    }

    if (stage === 'fix-design') {
      const rc = store.readBugfixStage(specsDir, folderName, 'root-cause');
      if (!rc) { console.error('Error: root-cause must exist.'); process.exit(1); }
      process.stderr.write('  Generating fix-design...');
      const result = await callLLM(prompts.buildBugfixPrompt('fix-design', ctx), rc);
      store.writeBugfixStage(specsDir, folderName, 'fix-design', result);
      console.log('  Wrote fix-design.md');
    } else if (stage === 'regression-tasks') {
      const rc = store.readBugfixStage(specsDir, folderName, 'root-cause');
      const fd = store.readBugfixStage(specsDir, folderName, 'fix-design');
      if (!rc || !fd) { console.error('Error: root-cause and fix-design must exist.'); process.exit(1); }
      process.stderr.write('  Generating regression-tasks...');
      const result = await callLLM(prompts.buildBugfixPrompt('regression-tasks', ctx), `## ROOT CAUSE\n${rc}\n\n## FIX DESIGN\n${fd}`);
      store.writeBugfixStage(specsDir, folderName, 'regression-tasks', result);
      console.log('  Wrote regression-tasks.md');
    } else if (stage === 'verify') {
      const rc = store.readBugfixStage(specsDir, folderName, 'root-cause');
      const fd = store.readBugfixStage(specsDir, folderName, 'fix-design');
      const rt = store.readBugfixStage(specsDir, folderName, 'regression-tasks');
      if (!rc || !fd || !rt) { console.error('Error: all three stages must exist for verify.'); process.exit(1); }
      process.stderr.write('  Verifying bugfix...');
      const result = await callLLM(prompts.buildBugfixPrompt('verify', ctx), prompts.buildBugfixVerificationPrompt(rc, fd, rt));
      store.writeBugfixStage(specsDir, folderName, 'verify', result);
      const score = parseHealthScore(result);
      console.log(`  Health Score: ${score ?? '?'}/100`);
    }
  }

  console.log('Bugfix cascade complete.');
}

// ── Templates listing ───────────────────────────────────────────────────────

function cmdTemplates() {
  console.log('Available spec templates:\n');
  for (const t of store.TEMPLATE_REGISTRY) {
    console.log(`  ${t.id.padEnd(16)} ${t.name} — ${t.description}`);
  }
  console.log('\nUsage: nspec init <name> --template <template-id>');
}

function cmdStatus() {
  const name = getPositional(0);

  if (!name) {
    // List all specs
    const specs = store.listSpecs(specsDir);
    if (specs.length === 0) {
      console.log('No specs found in ' + specsDir);
      return;
    }
    console.log(`Specs in ${specsDir}:\n`);
    for (const spec of specs) {
      const stages = store.ALL_STAGES.map(s => spec.stages[s] ? '●' : '○').join('');
      const pct = spec.progress
        ? ` ${spec.progress.done}/${spec.progress.total} tasks`
        : '';
      console.log(`  ${stages}  ${spec.name}${pct}`);
    }
  } else {
    // Show single spec detail
    const folderName = store.toFolderName(name);
    const specs = store.listSpecs(specsDir);
    const spec = specs.find(s => s.name === folderName);
    if (!spec) {
      console.error(`Spec not found: ${folderName}`);
      process.exit(1);
    }

    console.log(`Spec: ${spec.name}`);
    console.log(`Path: ${spec.folderPath}\n`);

    for (const stage of store.ALL_STAGES) {
      const has = !!spec.stages[stage];
      console.log(`  ${has ? '●' : '○'} ${stage}`);
    }

    if (spec.progress) {
      const pct = spec.progress.total > 0
        ? Math.round((spec.progress.done / spec.progress.total) * 100)
        : 0;
      console.log(`\n  Progress: ${spec.progress.done}/${spec.progress.total} (${pct}%)`);
    }

    // Show health score if verify exists
    if (spec.stages.verify) {
      const score = parseHealthScore(spec.stages.verify);
      if (score !== null) console.log(`  Health Score: ${score}/100`);
    }
  }
}

async function cmdRefine() {
  requireApiKey();
  const name = getPositional(0);
  const stage = getPositional(1);
  const feedback = getArg('--feedback');

  if (!name || !stage || !feedback) {
    console.error('Usage: nspec refine <name> <stage> --feedback "..."');
    process.exit(1);
  }
  if (!store.ALL_STAGES.includes(stage)) {
    console.error(`Error: stage must be one of: ${store.ALL_STAGES.join(', ')}`);
    process.exit(1);
  }

  const folderName = store.toFolderName(name);
  const content = store.readStage(specsDir, folderName, stage);
  if (!content) {
    console.error(`Error: ${stage} does not exist for spec ${folderName}.`);
    process.exit(1);
  }

  const sys = prompts.REFINE_SYSTEM;
  const user = prompts.buildRefinementPrompt(stage, content, feedback);

  process.stderr.write(`  Refining ${stage}...`);
  const result = await callLLM(sys, user);

  const isInquiry = result.trimStart().startsWith('<!-- INQUIRY -->');
  if (isInquiry) {
    console.log(result);
  } else {
    store.writeStage(specsDir, folderName, stage, result);
    if (stage === 'tasks') {
      store.syncProgressFromMarkdown(specsDir, folderName, result);
    }
    console.log(`Updated ${stage}.md`);
  }
}

// ── Steering setup ────────────────────────────────────────────────────────────

function cmdSetupSteering() {
  const wsRoot = process.cwd();
  const written = store.scaffoldSteering(specsDir, wsRoot);
  if (written.length === 0) {
    console.log('Could not infer any steering files from the workspace.');
  } else {
    console.log(`Generated steering files in ${path.join(specsDir, 'steering')}:`);
    for (const f of written) {
      console.log(`  ${f}`);
    }
    console.log('\nEdit these files to refine your project context. They will be included in all future spec generation.');
  }
}

// ── AGENTS.md generation ─────────────────────────────────────────────────────

function cmdSetupAgents() {
  const wsRoot = process.cwd();
  const agentsContent = generateAgentsMd();

  // Don't overwrite existing AGENTS.md — write to .specs/AGENTS.md instead
  const primaryPath = path.join(wsRoot, 'AGENTS.md');
  const fallbackPath = path.join(specsDir, 'AGENTS.md');

  if (fs.existsSync(primaryPath)) {
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(fallbackPath, agentsContent, 'utf-8');
    console.log(`AGENTS.md already exists at root. Wrote to ${fallbackPath}`);
  } else {
    fs.writeFileSync(primaryPath, agentsContent, 'utf-8');
    console.log(`Wrote ${primaryPath}`);
  }
}

function generateAgentsMd() {
  return `# nSpec — Agent Instructions

> This file teaches coding agents (Codex, Cursor, etc.) how to work with the nSpec spec system.

## What is nSpec?

nSpec is a requirements-first planning system. Before writing code, you create structured specifications:
**Requirements → Design → Tasks → Verify**

Each spec lives in \`.specs/<name>/\` as markdown files. This gives you a traceable, verifiable plan before touching any code.

## Folder Structure

\`\`\`
.specs/
├── <spec-name>/
│   ├── spec.config.json        # Auto-generated metadata
│   ├── requirements.md         # Functional & non-functional requirements
│   ├── design.md               # Technical architecture & component breakdown
│   ├── tasks.md                # Checkbox implementation plan with effort estimates
│   ├── verify.md               # Health score, coverage matrix, gap analysis
│   ├── _progress.json          # Task completion tracking
│   ├── _steering.md            # (optional) Domain context for this spec
│   ├── _role.md                # (optional) Override the AI's role preamble
│   ├── _prompts/               # (optional) Full prompt overrides per stage
│   │   └── requirements.md, design.md, tasks.md, verify.md
│   └── _sections/              # (optional) Extra output sections per stage
│       └── requirements.md, design.md, tasks.md, verify.md
├── steering/                   # (optional) Workspace-wide steering files
│   ├── product.md              # Product vision, target users
│   ├── tech.md                 # Technology stack, patterns, libraries
│   ├── structure.md            # Directory structure, module boundaries
│   └── testing.md              # Test conventions, coverage requirements
├── _steering.md                # (optional) Legacy workspace-wide domain context
├── _role.md                    # (optional) Workspace-wide role override
└── _prompts/                   # (optional) Workspace-wide prompt overrides
\`\`\`

## CLI Commands

All commands are run via \`node bin/nspec.mjs\` (or \`nspec\` if linked).

### Initialize a new spec
\`\`\`bash
nspec init <name>
# Creates .specs/<name>/ with spec.config.json
# Prints the folder path
\`\`\`

### Generate a stage
\`\`\`bash
# Requirements (needs --description)
nspec generate <name> requirements --description "Build a user auth system with OAuth2..."

# Design (reads requirements.md as input)
nspec generate <name> design

# Tasks (reads design.md as input)
nspec generate <name> tasks

# Verify (reads all three stages)
nspec generate <name> verify
\`\`\`

### Verify with different schemes
\`\`\`bash
nspec verify <name>                    # Default: audit (single-pass)
nspec verify <name> --scheme cove      # Chain of Verification (question-answer)
nspec verify <name> --scheme committee # Audit + CoVe synthesis (most thorough)
\`\`\`

### Cascade (generate all downstream stages)
\`\`\`bash
nspec cascade <name>                   # From design through verify
nspec cascade <name> --from tasks      # From tasks through verify
\`\`\`

### Check status
\`\`\`bash
nspec status           # List all specs with completion dots (●○○○)
nspec status <name>    # Detail view: stages, progress %, health score
\`\`\`

### Refine a stage
\`\`\`bash
nspec refine <name> <stage> --feedback "Add rate limiting to the auth requirements"
# If feedback is a question → prints inquiry response
# If feedback is a change request → updates the stage file
\`\`\`

### Set up agent instructions
\`\`\`bash
nspec setup-agents     # Writes this AGENTS.md file
\`\`\`

### Set up steering files
\`\`\`bash
nspec setup-steering   # Generates steering files from workspace (product.md, tech.md, structure.md)
\`\`\`

## Stage Pipeline

| Stage | Input | Output | Purpose |
|-------|-------|--------|---------|
| **requirements** | Feature description | FR-1..N, NFRs, constraints | What to build |
| **design** | requirements.md | Architecture, components, data models | How to build it |
| **tasks** | design.md | Checkbox list with S/M/L/XL estimates | What to code |
| **verify** | All three stages | Health score, coverage matrix, gaps | Is the spec complete? |

## When to Use CLI vs Direct Edit

| Action | Approach |
|--------|----------|
| Generate a new stage from scratch | CLI: \`nspec generate\` |
| Generate all remaining stages | CLI: \`nspec cascade\` |
| Run verification | CLI: \`nspec verify\` |
| Small wording tweaks | Direct edit the .md file |
| Add/remove a requirement | Direct edit, then \`nspec cascade --from design\` |
| Ask a question about the spec | CLI: \`nspec refine <name> <stage> --feedback "..."\` |
| Substantive rewrite of a section | CLI: \`nspec refine\` with change request |

## Reading verify.md and Acting on Gaps

After running verify, check:

1. **Health Score** — Target 80+. Below 60 means significant gaps.
2. **Coverage Matrix** — Look for \`UNCOVERED\` FRs. These need tasks added.
3. **Cascade Drift** — Requirements without matching design, or design without tasks. Fix upstream first.
4. **Gap Report** — Actionable items. Address each one, then re-verify.

**Typical flow to fix gaps:**
1. Read verify.md and identify issues
2. Edit the upstream document (requirements.md or design.md)
3. Run \`nspec cascade <name> --from design\` to regenerate downstream
4. Run \`nspec verify <name>\` to confirm improvement

## OpenSpec Customization

To customize AI behavior for a specific spec:

- **\`_steering.md\`** — Add domain context (e.g., "This is a healthcare app, all data must be HIPAA compliant")
- **\`_role.md\`** — Override the AI's role (e.g., "You are a mobile game designer")
- **\`_prompts/<stage>.md\`** — Completely replace the system prompt for a stage
- **\`_sections/<stage>.md\`** — Add extra output sections (one per line)

Workspace-wide files in \`.specs/\` apply to all specs. Spec-specific files override workspace-wide.

## Steering Files

Steering files inject persistent project context into every AI prompt. They live in \`.specs/steering/\` and are loaded alphabetically.

### Setup
\`\`\`bash
nspec setup-steering   # Auto-generates from workspace (package.json, README, tsconfig, etc.)
\`\`\`

### What to put in steering files
- **\`product.md\`** — Product vision, target users, business context
- **\`tech.md\`** — Technology stack, framework conventions, library choices
- **\`structure.md\`** — Directory layout, module boundaries, naming conventions
- **\`testing.md\`** — Test frameworks, coverage requirements, testing patterns

### When to update steering files
- When you adopt a new library or framework
- When you establish a new coding convention
- When the project structure changes significantly
- When you add a new integration or external dependency

### How steering files work
- All \`.specs/steering/*.md\` files are concatenated (alphabetically) into the system prompt
- They are combined with \`_steering.md\` (workspace-wide) and \`<spec>/_steering.md\` (spec-specific)
- Precedence: \`steering/*.md\` → \`_steering.md\` → \`<spec>/_steering.md\`
- Removing a steering file does not break anything — they are additive

### Workspace context injection
For **design** and **tasks** stages, nSpec also reads key project files (package.json, tsconfig, directory structure, relevant source files) and injects them into the prompt. This happens automatically — no configuration needed.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| \`NSPEC_API_KEY\` | (required) | OpenAI or Anthropic API key |
| \`NSPEC_API_BASE\` | \`https://api.openai.com/v1\` | API base URL |
| \`NSPEC_MODEL\` | \`gpt-4o\` | Model to use for generation |
| \`NSPEC_SPECS_DIR\` | \`.specs\` (relative to cwd) | Specs folder path |

## Vibe-to-Spec Workflow

When the user asks you to "generate a spec" or "turn this into a spec" during a conversation:

1. Save the relevant conversation context to a temporary file
2. Run: \`nspec vibe-to-spec <inferred-name> --transcript <file> --cascade\`
3. The spec pipeline will be generated from the conversation context

### CLI usage
\`\`\`bash
# From a file
nspec vibe-to-spec auth-feature --transcript chat.md

# From stdin
cat chat.md | nspec vibe-to-spec auth-feature

# With full cascade (generates requirements → design → tasks → verify)
nspec vibe-to-spec auth-feature --transcript chat.md --cascade
\`\`\`

### What happens internally
1. The transcript is parsed by AI to extract feature scope, decisions, constraints, and open questions
2. Requirements are generated using the extracted description + full transcript as context
3. If \`--cascade\` is used, design → tasks → verify are generated downstream
4. The extracted context is saved in \`spec.config.json\` under \`vibeContext\` so downstream stages benefit from it
`;
}

// ── Import command ───────────────────────────────────────────────────────────

async function cmdImport() {
  const name = getPositional(0);
  const stage = getPositional(1);
  const file = getPositional(2);
  const transform = args.includes('--transform');

  if (!name || !stage || !file) {
    console.error('Usage: nspec import <name> <stage> <file> [--transform]');
    console.error('Stages: requirements, design, tasks, verify');
    console.error('  --transform   AI-transform the file content into spec format before importing');
    process.exit(1);
  }
  if (!store.ALL_STAGES.includes(stage)) {
    console.error(`Error: stage must be one of: ${store.ALL_STAGES.join(', ')}`);
    process.exit(1);
  }

  const folderName = store.toFolderName(name);
  const filePath = path.resolve(file);

  if (!fs.existsSync(filePath)) {
    console.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }

  if (transform) {
    requireApiKey();
    const content = fs.readFileSync(filePath, 'utf-8');
    const ctx = buildPromptContext(folderName);
    ctx.extraSections = store.loadExtraSections(specsDir, folderName, stage);
    const customPrompt = store.loadCustomPrompt(specsDir, folderName, stage);
    const systemPrompt = customPrompt || prompts.buildSystemPrompt(stage, ctx);
    const userPrompt = `Convert the following document into the proper ${stage} format:\n\n${content}`;

    process.stderr.write(`  Transforming and importing ${stage}...`);
    const result = await callLLM(systemPrompt, userPrompt);
    store.createSpecFolder(specsDir, folderName);
    store.writeStage(specsDir, folderName, stage, result);
    if (stage === 'tasks') {
      store.syncProgressFromMarkdown(specsDir, folderName, result);
    }
    console.log(`Imported and transformed ${file} → ${stage}.md`);
  } else {
    store.importFile(specsDir, folderName, stage, filePath);
    console.log(`Imported ${file} → .specs/${folderName}/${stage}.md`);
  }
}

// ── Clarify command ──────────────────────────────────────────────────────────

import * as readline from 'readline';

async function cmdClarify() {
  requireApiKey();
  const name = getPositional(0);
  const description = getArg('--description');

  if (!name || !description) {
    console.error('Usage: nspec clarify <name> --description "..."');
    console.error('Interactive Q&A before requirements generation.');
    process.exit(1);
  }

  const folderName = store.toFolderName(name);
  store.createSpecFolder(specsDir, folderName);
  const ctx = buildPromptContext(folderName);
  ctx.extraSections = store.loadExtraSections(specsDir, folderName, 'requirements');
  const customPrompt = store.loadCustomPrompt(specsDir, folderName, 'requirements');

  // Step 1: Ask clarifying questions
  process.stderr.write('  Generating clarification questions...');
  const clarifySystem = prompts.CLARIFICATION_SYSTEM;
  const clarifyUser = prompts.buildClarificationUserPrompt(description);
  const questions = await callLLM(clarifySystem, clarifyUser);
  console.log('\n' + questions + '\n');

  // Step 2: Collect answers interactively
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answers = await new Promise((resolve) => {
    rl.question('Your answers (type your responses, then press Enter):\n> ', (ans) => {
      rl.close();
      resolve(ans);
    });
  });

  // Step 3: Generate requirements with clarification context
  const qaTranscript = `Questions:\n${questions}\n\nAnswers:\n${answers}`;
  const systemPrompt = customPrompt || prompts.buildSystemPrompt('requirements', ctx);
  const userPrompt = prompts.buildClarifiedRequirementsUserPrompt(description, qaTranscript);

  process.stderr.write('  Generating requirements with clarifications...');
  const result = await callLLM(systemPrompt, userPrompt);
  store.writeStage(specsDir, folderName, 'requirements', result);
  console.log(`Wrote requirements.md (with clarification context)`);
}

// ── Hooks commands ───────────────────────────────────────────────────────────

import { exec } from 'child_process';

function cmdHooks() {
  const subcommand = getPositional(0);

  if (subcommand === 'list') {
    const hooks = store.loadHooks(specsDir);
    if (hooks.length === 0) {
      console.log('No hooks defined. Create hook files in .specs/hooks/*.json');
      return;
    }
    console.log('Active hooks:\n');
    for (const hook of hooks) {
      console.log(`  ${hook.name}`);
      console.log(`    Trigger: ${hook.trigger} | Glob: ${hook.glob}`);
      console.log(`    Action: ${hook.action}`);
      console.log('');
    }
  } else if (subcommand === 'run') {
    const hookName = getPositional(1);
    if (!hookName) {
      console.error('Usage: nspec hooks run <hook-name>');
      process.exit(1);
    }

    const hooks = store.loadHooks(specsDir);
    const hook = hooks.find(h => h.name.toLowerCase() === hookName.toLowerCase() || h.name.toLowerCase().replace(/\s+/g, '-') === hookName.toLowerCase());
    if (!hook) {
      console.error(`Error: hook "${hookName}" not found. Run 'nspec hooks list' to see available hooks.`);
      process.exit(1);
    }

    const vars = {
      filePath: '',
      fileName: '',
      workspaceRoot: process.cwd().replace(/\\/g, '/'),
      specName: '',
    };
    const resolved = store.resolveHookAction(hook.action, vars);
    console.log(`Running hook: ${hook.name}`);
    console.log(`  Action: ${resolved}`);

    exec(resolved, { cwd: process.cwd(), timeout: 30000 }, (error, stdout, stderr) => {
      if (stdout) console.log(stdout.toString().trim());
      if (stderr) console.error(stderr.toString().trim());
      console.log(`Exit: ${error ? error.code ?? 1 : 0}`);
      process.exit(error ? 1 : 0);
    });
    return; // Don't fall through to process.exit
  } else {
    console.error('Usage: nspec hooks <list|run> [hook-name]');
    process.exit(1);
  }
}

// ── Vibe-to-spec command ─────────────────────────────────────────────────────

async function cmdVibeToSpec() {
  requireApiKey();
  const name = getPositional(0);
  if (!name) {
    console.error('Usage: nspec vibe-to-spec --name <name> [--transcript <file>] [--type feature|bugfix] [--mode requirements-first|design-first] [--cascade]');
    process.exit(1);
  }

  const folderName = store.toFolderName(name);
  const transcriptArg = getArg('--transcript');
  const specType = getArg('--type') || 'feature';
  const modeArg = getArg('--mode') || 'requirements-first';
  const doCascade = args.includes('--cascade');

  // Read transcript from file, explicit stdin flag, or auto-detect piped input
  let transcript = '';
  if (transcriptArg && transcriptArg !== '-') {
    const transcriptPath = path.resolve(transcriptArg);
    if (!fs.existsSync(transcriptPath)) {
      console.error(`Error: transcript file not found: ${transcriptPath}`);
      process.exit(1);
    }
    transcript = fs.readFileSync(transcriptPath, 'utf-8');
  } else if (args.includes('--stdin') || transcriptArg === '-' || !process.stdin.isTTY) {
    // Explicit --stdin, explicit '-' marker, or piped input detected
    transcript = fs.readFileSync(0, 'utf-8');
  } else {
    console.error('Error: provide --transcript <file>, --stdin, or pipe input via stdin.');
    console.error('  Examples:');
    console.error('    nspec vibe-to-spec my-feature --transcript chat.md');
    console.error('    cat chat.md | nspec vibe-to-spec my-feature');
    console.error('    echo "User: ..." | nspec vibe-to-spec my-feature');
    process.exit(1);
  }

  if (!transcript.trim()) {
    console.error('Error: empty transcript. Provide text via --transcript <file> or stdin.');
    process.exit(1);
  }

  // Step 1: Extract structured description from transcript
  process.stderr.write('  Extracting description from transcript...');
  const extractedDescription = await callLLM(
    prompts.VIBE_TO_SPEC_SYSTEM,
    prompts.buildVibeToSpecPrompt(transcript)
  );

  // Step 2: Create spec folder
  let mode = modeArg;
  if (specType === 'bugfix') mode = 'bugfix';
  store.createSpecFolder(specsDir, folderName, mode);

  // Step 3: Save vibe context
  store.writeVibeContext(specsDir, folderName, {
    transcript: transcript.length > 10000 ? transcript.slice(0, 10000) + '\n\n[...truncated]' : transcript,
    extractedDescription,
    generatedAt: new Date().toISOString(),
  });

  // Step 4: Generate requirements from extracted description
  const ctx = buildPromptContext(folderName);
  ctx.extraSections = store.loadExtraSections(specsDir, folderName, 'requirements');
  const customPrompt = store.loadCustomPrompt(specsDir, folderName, 'requirements');
  const systemPrompt = customPrompt || prompts.buildSystemPrompt('requirements', ctx);

  // Include transcript as extended context
  const userPrompt = `${extractedDescription}\n\n---\n## Original Conversation Transcript\n${transcript}`;

  process.stderr.write('  Generating requirements...');
  const requirements = await callLLM(systemPrompt, userPrompt);
  store.writeStage(specsDir, folderName, 'requirements', requirements);
  console.log('Wrote requirements.md (from conversation transcript)');

  // Step 5: Optionally cascade
  if (doCascade) {
    const scheme = getArg('--scheme') || 'audit';

    // Design
    process.stderr.write('  Generating design...');
    const desCtx = buildPromptContext(folderName);
    desCtx.extraSections = store.loadExtraSections(specsDir, folderName, 'design');
    const desSys = store.loadCustomPrompt(specsDir, folderName, 'design') || prompts.buildSystemPrompt('design', desCtx);
    const wsContext = getWorkspaceContext(folderName, 'design');
    const vibeAppend = `\n\n---\n## Conversation Context\n${extractedDescription}`;
    let desUser = wsContext ? `${requirements}\n\n${wsContext}` : requirements;
    desUser += vibeAppend;
    const design = await callLLM(desSys, desUser);
    store.writeStage(specsDir, folderName, 'design', design);
    console.log('  Wrote design.md');

    // Tasks
    process.stderr.write('  Generating tasks...');
    const taskCtx = buildPromptContext(folderName);
    taskCtx.extraSections = store.loadExtraSections(specsDir, folderName, 'tasks');
    const taskSys = store.loadCustomPrompt(specsDir, folderName, 'tasks') || prompts.buildSystemPrompt('tasks', taskCtx);
    const taskWsContext = getWorkspaceContext(folderName, 'tasks');
    let taskUser = taskWsContext ? `${design}\n\n${taskWsContext}` : design;
    taskUser += vibeAppend;
    const tasks = await callLLM(taskSys, taskUser);
    store.writeStage(specsDir, folderName, 'tasks', tasks);
    store.syncProgressFromMarkdown(specsDir, folderName, tasks);
    console.log('  Wrote tasks.md');

    // Verify
    process.stderr.write(`  Verifying (${scheme})...`);
    const verCtx = buildPromptContext(folderName);
    const verSys = store.loadCustomPrompt(specsDir, folderName, 'verify') || prompts.buildSystemPrompt('verify', verCtx);
    const verUser = prompts.buildVerificationPrompt(requirements, design, tasks);
    const verify = await callLLM(verSys, verUser);
    store.writeStage(specsDir, folderName, 'verify', verify);

    const score = parseHealthScore(verify);
    const uncovered = countUncovered(verify);
    console.log(`  Health Score: ${score ?? '?'}/100 | Uncovered: ${uncovered}`);
    console.log('Vibe-to-spec cascade complete.');
  }
}

// ── Check tasks command ──────────────────────────────────────────────────────

async function cmdCheckTasks() {
  const name = getPositional(0);
  if (!name) { console.error('Usage: nspec check-tasks <name>'); process.exit(1); }

  const wsRoot = process.cwd();
  const results = store.checkTaskCompletion(wsRoot, specsDir, name);

  if (results.length === 0) {
    console.log('No tasks found or tasks.md not generated yet.');
    return;
  }

  let complete = 0, partial = 0, incomplete = 0;

  for (const r of results) {
    let status, icon;
    if (r.score > 0.7) {
      status = 'COMPLETE';
      icon = '\u2705'; // green check
      complete++;
    } else if (r.score > 0.3) {
      status = 'PARTIAL';
      icon = '\u26A0\uFE0F'; // warning
      partial++;
    } else {
      status = 'INCOMPLETE';
      icon = '\u274C'; // red x
      incomplete++;
    }

    const evidence = r.evidence.length > 0 ? ` | Evidence: ${r.evidence.join(', ')}` : '';
    console.log(`${icon} [${status}] ${r.taskLabel}${evidence}`);
  }

  console.log(`\nSummary: ${complete} complete, ${partial} partial, ${incomplete} incomplete (${results.length} total)`);
}

// ── Workspace config command ──────────────────────────────────────────────────

async function cmdConfig() {
  const subcommand = getPositional(0);

  if (subcommand === 'set') {
    const key = getPositional(1);
    const value = getPositional(2);
    if (!key || !value) {
      console.error('Usage: nspec config set <key> <value>');
      console.error('Keys: requirements-format (values: ears, given-when-then)');
      process.exit(1);
    }
    const existing = store.loadWorkspaceConfig(specsDir) || {};
    if (key === 'requirements-format') {
      if (value !== 'ears' && value !== 'given-when-then') {
        console.error('Error: requirements-format must be "ears" or "given-when-then".');
        process.exit(1);
      }
      existing.requirementsFormat = value;
      store.writeWorkspaceConfig(specsDir, existing);
      console.log(`Workspace default: requirementsFormat = ${value}`);
    } else {
      console.error(`Unknown config key: ${key}`);
      console.error('Supported keys: requirements-format');
      process.exit(1);
    }
  } else if (subcommand === 'get' || !subcommand) {
    const wsConfig = store.loadWorkspaceConfig(specsDir);
    if (!wsConfig) {
      console.log('No workspace config found. Using defaults.');
    } else {
      console.log('Workspace config:');
      if (wsConfig.requirementsFormat) {
        console.log(`  requirements-format: ${wsConfig.requirementsFormat}`);
      }
    }
  } else {
    console.error('Usage: nspec config [get|set <key> <value>]');
    process.exit(1);
  }
}

// ── Main dispatch ────────────────────────────────────────────────────────────

const COMMANDS = {
  init: cmdInit,
  generate: cmdGenerate,
  verify: cmdVerify,
  cascade: cmdCascade,
  status: cmdStatus,
  refine: cmdRefine,
  backfill: cmdBackfill,
  'bugfix-generate': cmdBugfixGenerate,
  'bugfix-cascade': cmdBugfixCascade,
  templates: cmdTemplates,
  import: cmdImport,
  clarify: () => { console.error('clarify is not available in this version.'); process.exit(1); },
  hooks: cmdHooks,
  'vibe-to-spec': cmdVibeToSpec,
  'setup-agents': cmdSetupAgents,
  'setup-steering': cmdSetupSteering,
  'check-tasks': cmdCheckTasks,
  config: cmdConfig,
};

if (!command || !COMMANDS[command]) {
  console.log(`nSpec CLI — spec-driven development for coding agents

Usage: nspec <command> [options]

Commands:
  init <name> [options]               Create a new spec
  generate <name> <stage> [options]   Generate a stage (requirements|design|tasks|verify)
  verify <name> [--scheme <scheme>]   Run verification (audit|cove|committee)
  cascade <name> [--from <stage>]     Generate all stages downstream
  status [name]                       Show spec status
  refine <name> <stage> --feedback    Refine a stage with feedback
  import <name> <stage> <file>        Import an existing file as a spec stage
  backfill <name> requirements        Reverse-generate requirements from design (design-first)
  bugfix-generate <name> <stage>      Generate bugfix stage (root-cause|fix-design|regression-tasks|verify)
  bugfix-cascade <name> [--from]      Cascade bugfix stages downstream
  templates                           List available spec templates
  hooks <list|run> [hook-name]        Manage event-driven hooks
  vibe-to-spec <name> [options]      Convert conversation transcript into a spec
  setup-agents                        Generate AGENTS.md for coding agents
  check-tasks <name>                  Scan workspace for task completion evidence
  setup-steering                      Generate steering files from workspace
  config [get|set <key> <value>]      View or set workspace-level defaults

Init options:
  --type bugfix            Create a bugfix spec (root-cause pipeline)
  --mode design-first      Start from design, optionally backfill requirements
  --template <id>          Scaffold from a template (see: nspec templates)
  --format ears            Use EARS-style requirements (WHEN/IF … THE SYSTEM SHALL)

Generate options:
  --format ears            Use EARS-style requirements (requirements stage only)
  --format given-when-then Use Given/When/Then requirements (override workspace default)

Config keys:
  requirements-format      Default requirements format: ears | given-when-then

Options:
  --specs-dir <path>       Override specs folder (default: .specs)
  --description <text>     Feature description (for requirements / root-cause)
  --scheme <scheme>        Verification scheme: audit|cove|committee
  --from <stage>           Cascade starting point (default: design)
  --feedback <text>        Refinement feedback
  --context <spec-name>    Include another spec as reference context
  --transform              AI-transform imported file into spec format
  --transcript <file>      Transcript file for vibe-to-spec (or - for stdin)
  --cascade                Auto-cascade through design → tasks → verify

Environment:
  NSPEC_API_KEY        API key (required for generate/verify/cascade/refine)
  NSPEC_API_BASE       API base URL (default: https://api.openai.com/v1)
  NSPEC_MODEL          Model ID (default: gpt-4o)
  NSPEC_SPECS_DIR      Specs folder (default: .specs)`);
  process.exit(command ? 1 : 0);
}

Promise.resolve(COMMANDS[command]()).catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
