#!/usr/bin/env node
/**
 * nSpec Prompt Tuning Harness
 *
 * Supports:
 *   Full pipeline:   node test-harness.mjs --spec "Feature" --prompt "Description"
 *   Single stage:    node test-harness.mjs --stage requirements --spec "Feature" --prompt "Description"
 *   With prior run:  node test-harness.mjs --stage verify --input-dir .harness-runs/v2-*
 *   Verify schemes:  node test-harness.mjs --spec "Feature" --prompt "Desc" --verify-scheme committee
 *   Refine:          node test-harness.mjs --stage refine --input-dir .harness-runs/v2-* --refine-stage requirements --prompt "Remove X"
 *   Refine+cascade:  node test-harness.mjs --stage refine --input-dir .harness-runs/v2-* --refine-stage requirements --prompt "Remove X" --cascade
 *   Cascade from:    node test-harness.mjs --stage design --input-dir .harness-runs/v2-* --cascade
 *   Test scaffold:   node test-harness.mjs --stage test --input-dir .harness-runs/v2-* --test-config test.json
 *
 * Env:
 *   NSPEC_API_KEY   — OpenAI or Anthropic API key (required)
 *   NSPEC_API_BASE  — Base URL (default: https://api.openai.com/v1)
 *   NSPEC_MODEL     — Model ID (default: gpt-4o)
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const prompts = require('./out/prompts.js');

// ── Arg parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

const SPEC_NAME      = getArg('--spec') || 'Test Spec';
const FEATURE_DESC   = getArg('--prompt') || null;
const TAG            = getArg('--tag') || 'run';
const STEERING_FILE  = getArg('--steering') || null;
const ROLE_FILE      = getArg('--role') || null;
const STAGE          = getArg('--stage') || null;
const INPUT_DIR      = getArg('--input-dir') || null;
const VERIFY_SCHEME  = getArg('--verify-scheme') || 'committee';
const REFINE_STAGE   = getArg('--refine-stage') || null;
const TEST_CONFIG    = getArg('--test-config') || null;
const CASCADE        = args.includes('--cascade');

const API_KEY    = process.env.NSPEC_API_KEY || '';
const BASE_URL   = (process.env.NSPEC_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL      = process.env.NSPEC_MODEL || 'gpt-4o';
const IS_ANTHROPIC = BASE_URL.includes('anthropic') || API_KEY.startsWith('sk-ant');

const ALL_STAGES = ['requirements', 'design', 'tasks', 'verify', 'refine', 'test'];

// ── Validation ──────────────────────────────────────────────────────────────

if (!API_KEY) {
  console.error('Error: NSPEC_API_KEY env var is required.');
  process.exit(1);
}
if (STAGE && !ALL_STAGES.includes(STAGE)) {
  console.error(`Error: --stage must be one of: ${ALL_STAGES.join(', ')}`);
  process.exit(1);
}
if (!['audit', 'cove', 'committee'].includes(VERIFY_SCHEME)) {
  console.error('Error: --verify-scheme must be audit, cove, or committee');
  process.exit(1);
}
if (!STAGE && !FEATURE_DESC) {
  console.error(`Usage:
  Full pipeline:   node test-harness.mjs --spec "Name" --prompt "Description"
  Single stage:    node test-harness.mjs --stage <stage> [options]

Stages: ${ALL_STAGES.join(', ')}

Options:
  --tag <label>              Label this run for comparison
  --steering <file>          Markdown file with domain context
  --role <file>              Markdown file with role override
  --verify-scheme <scheme>   audit | cove | committee (default: committee)
  --input-dir <path>         Read inputs from a prior run directory
  --refine-stage <stage>     Which document to refine (for --stage refine)
  --test-config <file>       JSON config for test scaffold generation
  --cascade                  After this stage, continue the pipeline downstream + verify`);
  process.exit(1);
}

// ── Prompt context ──────────────────────────────────────────────────────────

function readOpt(filePath) {
  if (!filePath) return undefined;
  if (!fs.existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }
  return fs.readFileSync(filePath, 'utf-8').trim() || undefined;
}

function readInputFile(name) {
  if (!INPUT_DIR) return null;
  const p = path.join(INPUT_DIR, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8').trim();
}

const promptCtx = {
  title: SPEC_NAME,
  role: readOpt(ROLE_FILE),
  steering: readOpt(STEERING_FILE),
  extraSections: [],
};

// ── API caller ──────────────────────────────────────────────────────────────

let totalTokensIn = 0;
let totalTokensOut = 0;

async function callLLM(systemPrompt, userPrompt, showTiming) {
  const start = Date.now();
  const result = IS_ANTHROPIC
    ? await callAnthropic(systemPrompt, userPrompt)
    : await callOpenAI(systemPrompt, userPrompt);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (showTiming) process.stdout.write(` (${elapsed}s, ~${(result.length / 4).toFixed(0)} tok)`);
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
  if (json.usage) { totalTokensIn += json.usage.prompt_tokens; totalTokensOut += json.usage.completion_tokens; }
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
  if (json.usage) { totalTokensIn += json.usage.input_tokens; totalTokensOut += json.usage.output_tokens; }
  return json.content?.map(b => b.text).join('') || '';
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseHealthScore(text) {
  const m = text.match(/(?:Health|Final)\s*Score[:\s]+([\d]+)/i);
  return m ? parseInt(m[1], 10) : null;
}
function countFRs(text) { return (text.match(/FR-\d+/g) || []).length; }
function countTasks(text) { return (text.match(/^[\s]*- \[[ xX]\]/gm) || []).length; }
function countUncovered(text) { return (text.match(/UNCOVERED/gi) || []).length; }

// ── Output ──────────────────────────────────────────────────────────────────

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = path.join('.harness-runs', `${TAG}-${timestamp}`);

function save(filename, content) {
  const dir = path.dirname(path.join(runDir, filename));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(runDir, filename), content, 'utf-8');
}

// ── Stage runners ───────────────────────────────────────────────────────────

async function stageRequirements(featureDesc) {
  const sys = prompts.buildSystemPrompt('requirements', promptCtx);
  save('_prompts/requirements.md', sys);
  process.stdout.write('  Requirements...');
  const result = await callLLM(sys, featureDesc, true);
  save('requirements.md', result);
  console.log(' done');
  return result;
}

async function stageDesign(requirements) {
  const sys = prompts.buildSystemPrompt('design', promptCtx);
  save('_prompts/design.md', sys);
  process.stdout.write('  Design...');
  const result = await callLLM(sys, requirements, true);
  save('design.md', result);
  console.log(' done');
  return result;
}

async function stageTasks(design) {
  const sys = prompts.buildSystemPrompt('tasks', promptCtx);
  save('_prompts/tasks.md', sys);
  process.stdout.write('  Tasks...');
  const result = await callLLM(sys, design, true);
  save('tasks.md', result);
  console.log(' done');
  return result;
}

// ── Verification schemes ────────────────────────────────────────────────────

async function verifyAudit(docs) {
  const sys = prompts.buildSystemPrompt('verify', promptCtx);
  const user = prompts.buildVerificationPrompt(docs.requirements, docs.design, docs.tasks);
  save('_prompts/verify-audit.md', sys);
  process.stdout.write('    Audit...');
  const result = await callLLM(sys, user, true);
  save('verify-audit.md', result);
  console.log(' done');
  return result;
}

async function verifyCove(docs) {
  // Step 1: Generate questions
  const qSys = prompts.buildCoveQuestionsSystem(promptCtx);
  const qUser = prompts.buildCoveQuestionsUserPrompt(docs.requirements, docs.design, docs.tasks);
  save('_prompts/verify-cove-questions.md', qSys);
  process.stdout.write('    CoVe questions...');
  const questions = await callLLM(qSys, qUser, true);
  save('verify-cove-questions.md', questions);
  console.log(' done');

  // Step 2: Answer questions and produce verdict
  const vSys = prompts.buildCoveVerdictSystem(promptCtx);
  const vUser = prompts.buildCoveVerdictUserPrompt(docs.requirements, docs.design, docs.tasks, questions);
  save('_prompts/verify-cove-verdict.md', vSys);
  process.stdout.write('    CoVe verdict...');
  const verdict = await callLLM(vSys, vUser, true);
  save('verify-cove-verdict.md', verdict);
  console.log(' done');

  return verdict;
}

async function verifyCommittee(docs) {
  // Audit and CoVe questions in parallel
  const auditSys = prompts.buildSystemPrompt('verify', promptCtx);
  const auditUser = prompts.buildVerificationPrompt(docs.requirements, docs.design, docs.tasks);
  const qSys = prompts.buildCoveQuestionsSystem(promptCtx);
  const qUser = prompts.buildCoveQuestionsUserPrompt(docs.requirements, docs.design, docs.tasks);

  save('_prompts/verify-audit.md', auditSys);
  save('_prompts/verify-cove-questions.md', qSys);

  process.stdout.write('    Audit + CoVe questions (parallel)...');
  const [auditResult, questions] = await Promise.all([
    callLLM(auditSys, auditUser),
    callLLM(qSys, qUser),
  ]);
  save('verify-audit.md', auditResult);
  save('verify-cove-questions.md', questions);
  console.log(' done');

  // CoVe verdict (needs questions)
  const vSys = prompts.buildCoveVerdictSystem(promptCtx);
  const vUser = prompts.buildCoveVerdictUserPrompt(docs.requirements, docs.design, docs.tasks, questions);
  save('_prompts/verify-cove-verdict.md', vSys);
  process.stdout.write('    CoVe verdict...');
  const coveVerdict = await callLLM(vSys, vUser, true);
  save('verify-cove-verdict.md', coveVerdict);
  console.log(' done');

  // Committee synthesis
  const cSys = prompts.buildCommitteeSystem(promptCtx);
  const cUser = prompts.buildCommitteeUserPrompt(auditResult, coveVerdict);
  save('_prompts/verify-committee.md', cSys);
  process.stdout.write('    Committee synthesis...');
  const committee = await callLLM(cSys, cUser, true);
  save('verify-committee.md', committee);
  console.log(' done');

  return { audit: auditResult, cove: coveVerdict, committee };
}

async function stageVerify(scheme, docs) {
  console.log(`  Verify (${scheme}):`);
  switch (scheme) {
    case 'audit': {
      const result = await verifyAudit(docs);
      save('verify.md', result);
      return result;
    }
    case 'cove': {
      const result = await verifyCove(docs);
      save('verify.md', result);
      return result;
    }
    case 'committee': {
      const { audit, cove, committee } = await verifyCommittee(docs);
      save('verify.md', committee);
      return committee;
    }
  }
}

// ── Refine & Test ───────────────────────────────────────────────────────────

async function stageRefine(refineStage, content, feedback) {
  const sys = prompts.REFINE_SYSTEM;
  const user = prompts.buildRefinementPrompt(refineStage, content, feedback);
  save('_prompts/refine.md', sys);
  process.stdout.write(`  Refine (${refineStage})...`);
  const result = await callLLM(sys, user, true);
  const isInquiry = result.trimStart().startsWith('<!-- INQUIRY -->');
  save(`refine-${refineStage}.md`, result);
  console.log(isInquiry ? ' done (inquiry)' : ' done (revision)');
  return result;
}

async function stageTest(docs) {
  if (!TEST_CONFIG) {
    console.error('Error: --test-config <file.json> required for test stage');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(TEST_CONFIG, 'utf-8'));
  const wsCtx = {
    language: config.language || 'TypeScript',
    testFramework: config.testFramework || 'Vitest',
    testDir: config.testDir || 'tests/',
    testFileExt: config.testFileExt || '.test.ts',
    existingTestSnippet: config.existingTestSnippet || null,
  };
  const quest = {
    badOutputDescription: config.badOutputDescription || '',
    exclusions: config.exclusions || '',
    goodExample: config.goodExample || '',
    badExample: config.badExample || '',
  };
  const sys = prompts.TESTS_SYSTEM;
  const user = prompts.buildTestScaffoldPrompt(
    docs.requirements, docs.design, docs.tasks, wsCtx, quest, SPEC_NAME
  );
  save('_prompts/test.md', sys);
  process.stdout.write('  Test scaffold...');
  const result = await callLLM(sys, user, true);
  save(`test-scaffold${wsCtx.testFileExt}`, result);
  console.log(' done');
  return result;
}

// ── Cascade ─────────────────────────────────────────────────────────────────
// Continue the pipeline from a given point downstream, ending with verify.
// `docs` holds whatever has been produced so far; `from` is where to start.

const PIPELINE_ORDER = ['requirements', 'design', 'tasks', 'verify'];

async function cascadeFrom(from, docs) {
  const startIdx = PIPELINE_ORDER.indexOf(from);
  if (startIdx < 0) return docs;

  console.log(`\n  Cascading: ${PIPELINE_ORDER.slice(startIdx).join(' -> ')}`);

  for (let i = startIdx; i < PIPELINE_ORDER.length; i++) {
    const stage = PIPELINE_ORDER[i];
    switch (stage) {
      case 'requirements':
        // requirements is the top — nothing to re-generate from
        break;
      case 'design':
        docs.design = await stageDesign(docs.requirements);
        break;
      case 'tasks':
        docs.tasks = await stageTasks(docs.design);
        break;
      case 'verify':
        docs.verify = await stageVerify(VERIFY_SCHEME, docs);
        break;
    }
  }

  return docs;
}

// ── Scorecard ───────────────────────────────────────────────────────────────

function generateScorecard(verify, requirements, tasks, elapsed) {
  const score = parseHealthScore(verify);
  const frCount = countFRs(requirements || '');
  const taskCount = countTasks(tasks || '');
  const uncovered = countUncovered(verify);

  return `# Scorecard -- ${SPEC_NAME}
Run: ${TAG} | ${new Date().toISOString()} | ${MODEL}
Verify: ${VERIFY_SCHEME}
Input: ${(FEATURE_DESC || '(from input-dir)').slice(0, 120)}

## Results
| Metric | Value |
|---|---|
| Health Score | ${score ?? '?'} / 100 |
| Verify Scheme | ${VERIFY_SCHEME} |
| Functional Requirements | ${frCount} |
| Tasks generated | ${taskCount} |
| Uncovered FRs | ${uncovered} |
| Total tokens (in/out) | ~${totalTokensIn} / ~${totalTokensOut} |
| Wall time | ${elapsed}s |

## Prompt tuning hints
Review \`_prompts/\` to see exactly what was sent. Common tweaks:

- Requirements too vague? Add domain-specific sections via --steering or _sections/
- Design too generic? Add "Include code snippets for key interfaces" to DESIGN template
- Tasks missing coverage? Add "Cross-reference every FR-N" to TASKS template
- Score inflated? Try --verify-scheme committee for multi-perspective scoring
- Verify too lenient? Try --verify-scheme cove for evidence-based verification

## Compare runs
\`\`\`bash
diff -r .harness-runs/${TAG}-* .harness-runs/<other-tag>-*
\`\`\`
`;
}

// ── Single stage ────────────────────────────────────────────────────────────

async function runSingleStage() {
  const runStart = Date.now();

  console.log(`\n  nSpec Harness -- ${STAGE}`);
  console.log(`  ${'='.repeat(36)}`);
  console.log(`  Spec:      ${SPEC_NAME}`);
  console.log(`  Model:     ${MODEL}`);
  console.log(`  Stage:     ${STAGE}`);
  if (INPUT_DIR) console.log(`  Input:     ${INPUT_DIR}`);
  if (STAGE === 'verify' || CASCADE) console.log(`  Scheme:    ${VERIFY_SCHEME}`);
  if (CASCADE) console.log(`  Cascade:   yes`);
  console.log(`  Output:    ${runDir}/\n`);

  save('_run.json', JSON.stringify({
    spec: SPEC_NAME, prompt: FEATURE_DESC, model: MODEL, tag: TAG,
    stage: STAGE, verifyScheme: VERIFY_SCHEME, inputDir: INPUT_DIR,
    cascade: CASCADE, timestamp: new Date().toISOString(),
  }, null, 2));

  // Collect docs for potential cascade
  let docs = {
    requirements: readInputFile('requirements.md'),
    design: readInputFile('design.md'),
    tasks: readInputFile('tasks.md'),
  };

  // Determine which stage downstream to cascade from (stage after current one)
  let cascadeStart = null;

  switch (STAGE) {
    case 'requirements': {
      if (!FEATURE_DESC) { console.error('Error: --prompt required for requirements stage'); process.exit(1); }
      docs.requirements = await stageRequirements(FEATURE_DESC);
      cascadeStart = 'design';
      break;
    }
    case 'design': {
      if (!docs.requirements) { console.error('Error: --input-dir with requirements.md needed'); process.exit(1); }
      docs.design = await stageDesign(docs.requirements);
      cascadeStart = 'tasks';
      break;
    }
    case 'tasks': {
      if (!docs.design) { console.error('Error: --input-dir with design.md needed'); process.exit(1); }
      docs.tasks = await stageTasks(docs.design);
      cascadeStart = 'verify';
      break;
    }
    case 'verify': {
      if (!docs.requirements || !docs.design || !docs.tasks) {
        console.error('Error: --input-dir with requirements.md, design.md, tasks.md needed');
        process.exit(1);
      }
      const verify = await stageVerify(VERIFY_SCHEME, docs);
      const elapsed = ((Date.now() - runStart) / 1000).toFixed(0);
      save('_scorecard.md', generateScorecard(verify, docs.requirements, docs.tasks, elapsed));
      cascadeStart = null; // nothing downstream
      break;
    }
    case 'refine': {
      if (!REFINE_STAGE) { console.error('Error: --refine-stage required (requirements|design|tasks)'); process.exit(1); }
      if (!FEATURE_DESC) { console.error('Error: --prompt required (the feedback/question)'); process.exit(1); }
      const content = readInputFile(`${REFINE_STAGE}.md`);
      if (!content) { console.error(`Error: --input-dir with ${REFINE_STAGE}.md needed`); process.exit(1); }
      const refined = await stageRefine(REFINE_STAGE, content, FEATURE_DESC);
      const isInquiry = refined.trimStart().startsWith('<!-- INQUIRY -->');

      if (!isInquiry) {
        // Update the docs with the refined content for cascade
        docs[REFINE_STAGE] = refined;
        save(`${REFINE_STAGE}.md`, refined);  // save as the canonical version too

        // Cascade starts from the stage after the refined one
        const pipeIdx = PIPELINE_ORDER.indexOf(REFINE_STAGE);
        cascadeStart = pipeIdx >= 0 && pipeIdx < PIPELINE_ORDER.length - 1
          ? PIPELINE_ORDER[pipeIdx + 1]
          : null;
      }
      break;
    }
    case 'test': {
      if (!docs.requirements || !docs.design || !docs.tasks) {
        console.error('Error: --input-dir with requirements.md, design.md, tasks.md needed');
        process.exit(1);
      }
      await stageTest(docs);
      cascadeStart = null;
      break;
    }
  }

  // Cascade downstream if requested
  if (CASCADE && cascadeStart) {
    docs = await cascadeFrom(cascadeStart, docs);
    if (docs.verify) {
      const elapsed = ((Date.now() - runStart) / 1000).toFixed(0);
      save('_scorecard.md', generateScorecard(docs.verify, docs.requirements, docs.tasks, elapsed));

      const score = parseHealthScore(docs.verify);
      const frCount = countFRs(docs.requirements || '');
      const taskCount = countTasks(docs.tasks || '');
      const uncovered = countUncovered(docs.verify);
      console.log(`\n  --------------------------------`);
      console.log(`  Health Score:  ${score ?? '?'} / 100`);
      console.log(`  FRs:           ${frCount}`);
      console.log(`  Tasks:         ${taskCount}`);
      console.log(`  Uncovered:     ${uncovered}`);
      console.log(`  --------------------------------`);
    }
  }

  const elapsed = ((Date.now() - runStart) / 1000).toFixed(0);
  console.log(`\n  Time:    ${elapsed}s`);
  console.log(`  Tokens:  ~${totalTokensIn} in / ~${totalTokensOut} out`);
  console.log(`  Output:  ${runDir}/\n`);
}

// ── Full pipeline ───────────────────────────────────────────────────────────

async function runFullPipeline() {
  const runStart = Date.now();

  console.log(`\n  nSpec Prompt Tuning Harness`);
  console.log(`  ================================`);
  console.log(`  Spec:      ${SPEC_NAME}`);
  console.log(`  Model:     ${MODEL}`);
  console.log(`  Tag:       ${TAG}`);
  console.log(`  Verify:    ${VERIFY_SCHEME}`);
  console.log(`  Steering:  ${STEERING_FILE || '(none)'}`);
  console.log(`  Role:      ${ROLE_FILE || '(default)'}`);
  console.log(`  Output:    ${runDir}/\n`);

  save('_run.json', JSON.stringify({
    spec: SPEC_NAME, prompt: FEATURE_DESC, model: MODEL, tag: TAG,
    verifyScheme: VERIFY_SCHEME, steering: STEERING_FILE, role: ROLE_FILE,
    timestamp: new Date().toISOString(),
  }, null, 2));
  save('_prompts/_input.md', FEATURE_DESC);
  if (promptCtx.steering) save('_prompts/_steering.md', promptCtx.steering);
  if (promptCtx.role) save('_prompts/_role.md', promptCtx.role);

  // Stage 1-3
  process.stdout.write('  [1/4]'); const requirements = await stageRequirements(FEATURE_DESC);
  process.stdout.write('  [2/4]'); const design = await stageDesign(requirements);
  process.stdout.write('  [3/4]'); const tasks = await stageTasks(design);

  // Stage 4: Verify with selected scheme
  console.log(`  [4/4]`);
  const docs = { requirements, design, tasks };
  const verify = await stageVerify(VERIFY_SCHEME, docs);

  // Scorecard + summary
  const elapsed = ((Date.now() - runStart) / 1000).toFixed(0);
  save('_scorecard.md', generateScorecard(verify, requirements, tasks, elapsed));

  const score = parseHealthScore(verify);
  const frCount = countFRs(requirements);
  const taskCount = countTasks(tasks);
  const uncovered = countUncovered(verify);

  console.log(`\n  --------------------------------`);
  console.log(`  Health Score:  ${score ?? '?'} / 100`);
  console.log(`  Verify:        ${VERIFY_SCHEME}`);
  console.log(`  FRs:           ${frCount}`);
  console.log(`  Tasks:         ${taskCount}`);
  console.log(`  Uncovered:     ${uncovered}`);
  console.log(`  Tokens:        ~${totalTokensIn} in / ~${totalTokensOut} out`);
  console.log(`  Time:          ${elapsed}s`);
  console.log(`  --------------------------------`);
  console.log(`\n  Output:     ${runDir}/`);
  console.log(`  Scorecard:  ${runDir}/_scorecard.md`);
  console.log(`  Prompts:    ${runDir}/_prompts/\n`);
}

// ── Main ────────────────────────────────────────────────────────────────────

(STAGE ? runSingleStage() : runFullPipeline()).catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
