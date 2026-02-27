// ── Types ────────────────────────────────────────────────────────────────────

type Stage = 'requirements' | 'design' | 'tasks' | 'verify';

/** Requirements format for generation. */
export type RequirementsFormat = 'given-when-then' | 'ears';

export interface PromptContext {
  title: string;
  role?: string; // override the default role preamble
  steering?: string; // domain context injected into every prompt
  extraSections?: string[]; // additional sections appended to the stage defaults
  /** When true, design should be light and inferred from existing codebase/adjacent components. */
  lightDesign?: boolean;
  /** When 'ears', use EARS-style requirements (WHEN/IF … THE SYSTEM SHALL). */
  requirementsFormat?: RequirementsFormat;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_ROLE = 'You are a senior software architect practising spec-driven development.';

// Minimal core sections — extensible via _sections/ markdown drops.
const SECTIONS: Record<Stage, string[]> = {
  requirements: [
    'Overview',
    'Functional Requirements — numbered (FR-1, FR-2…), each with a User Story and Acceptance Criteria in Given/When/Then format',
    'Non-Functional Requirements',
    'Constraints & Assumptions',
  ],
  design: [
    'Overview',
    'Architecture',
    'Sequence Diagrams — at least one Mermaid sequence diagram for the main user/system or component interaction flow',
    'Component Breakdown',
    'Data Models',
    'Technology Choices',
  ],
  tasks: [],
  verify: [
    'Spec Health Score [0-100] — composite score and one-line verdict',
    'Given/When/Then Compliance — list any acceptance criteria that do not follow Given/When/Then format',
    'Coverage Matrix — parse _Requirements: FR-N_ fields from tasks to build the matrix, flag uncovered FRs as UNCOVERED',
    'Cascade Drift — (1) requirements not reflected in design, (2) design decisions missing from tasks, (3) requirements→design component mapping, (4) design→task mapping',
    'Gap Report — uncovered requirements, underspecified tasks, missing risk coverage',
    'Recommended Additions — ready-to-paste task list using - [ ] format',
    'Verdict — one paragraph on spec quality and implementation readiness',
  ],
};

// ── Core templates ───────────────────────────────────────────────────────────
// Each template uses {role}, {title}, {steering}, {sections}.
// Keep these concise — steer via context, not prescription.

const REQUIREMENTS_EARS_TEMPLATE = `{role}
{steering}
Given a feature description, produce a Requirements Document in Markdown using EARS (Easy Approach to Requirements Syntax).

# Requirements — {title}

{sections}

Each requirement MUST be written in EARS format. Use these patterns:
- **WHEN** [trigger/condition] **THE SYSTEM SHALL** [behavior]
- **IF** [precondition] **THEN THE SYSTEM SHALL** [behavior]
- **WHILE** [state] **THE SYSTEM SHALL** [behavior] (for continuous behavior)

Rules:
- Number requirements (Requirement 1, 1.1, 1.2, Requirement 2, …).
- Use THE SYSTEM SHALL (mandatory). Do not use "should" or "may" for mandatory behavior.
- Each requirement must be testable and unambiguous.
- Keep Functional Requirements to 5-10 items. Add Non-Functional Requirements (3-5) where the description implies them.
- No implementation details — those belong in Design.
- Do not invent features the user did not ask for.`;

const TEMPLATES: Record<Stage, string> = {
  requirements: `{role}
{steering}
Given a feature description, produce a Requirements Document in Markdown.

# Requirements — {title}

{sections}

Each Functional Requirement MUST include:
1. A User Story: As a <role>, I want <goal> so that <benefit>
2. Acceptance Criteria using Given/When/Then format (one or more per FR):
   - GIVEN <precondition> WHEN <action> THEN <expected result>
   - AND <additional condition or result> (to chain multiple conditions)

Guidelines:
- Focus on the core MVP. Only include requirements that are essential to the described feature.
- Each acceptance criterion MUST use the Given/When/Then format above.
- Do not use vague verbs (support, handle, manage) — Given/When/Then forces specificity.
- Keep Functional Requirements to 5-10 items with 2-4 acceptance criteria each.
- Use MUST sparingly — reserve it for true must-haves. Use SHOULD and MAY for stretch goals.
- Keep Non-Functional Requirements to 3-5 items. Only include what the description implies.
- No implementation details — those belong in Design.
- Do not invent features, compliance programs, or infrastructure the user did not ask for.`,

  design: `{role}
{steering}
Produce a Technical Design Document from the given Requirements Document.

# Design — {title}

{sections}
{lightDesignNote}

Guidelines:
- Match complexity to the project scope. A simple feature gets a simple design.
- Include at least one Mermaid sequence diagram (in a \`\`\`mermaid\`\`\` code block) showing the main flow between user, system, and key components.
- Favor the simplest technology choices that satisfy the requirements. Do not over-engineer.
- Include code snippets and type definitions only for key interfaces and non-obvious logic.
- Stay aligned with the Requirements. Do not introduce features or infrastructure not required.
- Keep the document under 300 lines. If it's longer, you're over-specifying.`,

  tasks: `{role}
{steering}
Convert the given Design Document into an executable Implementation Plan.

# Implementation Plan — {title}

Output a Markdown checkbox list grouped into logical phases.
Each task: \`- [ ] Description (S|M|L|XL) _Requirements: FR-N, FR-N_\`
Effort: S < 2h, M = 2-4h, L = 4-8h, XL > 8h.

Guidelines:
- Limit to 3-7 phases covering build work only. Do not include phases for documentation, deployment, post-launch, or compliance programs unless the requirements explicitly demand them.
- Target 30-80 total tasks. If you exceed this, consolidate — group related items into single tasks with sub-steps.
- Each task should map to a code change or testable outcome. Remove tasks that are purely process or ceremony.
- Order by dependency. A developer should be able to work top-to-bottom.
- Every task MUST end with _Requirements: FR-N, FR-N_ listing which FRs it addresses.
- A task may cover multiple FRs. Every FR must appear in at least one task.
- If a task has no FR mapping, it is infrastructure — mark it _Requirements: infrastructure_.`,

  verify: `{role}
{steering}
Audit three spec documents (Requirements, Design, Tasks) for completeness and consistency.

# Verification — {title}

{sections}

Guidelines:
- Be precise and concise. Cite FR numbers and task labels.
- Only flag real issues — not hypothetical future concerns or nice-to-haves.
- For Given/When/Then Compliance, check each acceptance criterion in Requirements for proper Given/When/Then format. Flag any that use vague verbs or free-form prose instead of structured Given/When/Then.
- For the Coverage Matrix, parse the _Requirements: FR-N, FR-N_ fields from each task checkbox line. Build the matrix from these parsed fields, not from inference. Flag any FR that does not appear in any task's _Requirements:_ field as UNCOVERED.
- For Cascade Drift, check: (1) every FR in Requirements has a corresponding component or section in Design, (2) every Design component has corresponding tasks, (3) no Design decisions contradict Requirements, (4) no Tasks reference features absent from Design. Flag each drift item as DRIFT with the source FR/component.
- Keep the Gap Report to genuine gaps, not wishlist items. If a MAY requirement is uncovered, note it but do not penalize the score.
- Keep the entire document under 150 lines.`,
};

// ── Assembly ─────────────────────────────────────────────────────────────────

const SECTIONS_EARS_REQUIREMENTS = [
  'Overview',
  'Functional Requirements — numbered (Requirement 1, 1.1, …), each in EARS form: WHEN/IF … THE SYSTEM SHALL …',
  'Non-Functional Requirements',
  'Constraints & Assumptions',
];

export function buildSystemPrompt(stage: Stage, ctx: PromptContext): string {
  const useEars = stage === 'requirements' && ctx.requirementsFormat === 'ears';
  const template = useEars ? REQUIREMENTS_EARS_TEMPLATE : TEMPLATES[stage];
  const role = ctx.role || DEFAULT_ROLE;
  const steering = ctx.steering ? `Context:\n${ctx.steering}` : '';
  const sectionList =
    stage === 'requirements' && useEars ? SECTIONS_EARS_REQUIREMENTS : SECTIONS[stage];
  const allSections = [...sectionList, ...(ctx.extraSections || [])];
  const sectionsStr =
    allSections.length > 0
      ? 'Include these sections:\n' + allSections.map((s) => `- ${s}`).join('\n')
      : '';

  const lightDesignNote =
    stage === 'design' && ctx.lightDesign
      ? '\nThis is a light-design spec (existing codebase): keep the design concise; infer from existing architecture, adjacent components, and workspace context; avoid re-specifying what already exists.\n'
      : '';

  return template
    .replace(/{role}/g, role)
    .replace(/{title}/g, ctx.title)
    .replace(/{steering}/g, steering)
    .replace(/{sections}/g, sectionsStr)
    .replace(/{lightDesignNote}/g, lightDesignNote)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Expose defaults so the harness and docs can reference them.
export { SECTIONS, TEMPLATES, DEFAULT_ROLE };

// ── Refine / Ask ─────────────────────────────────────────────────────────────

export const REFINE_SYSTEM = `You are a senior software architect assisting with a specification document.
The document provides context for your conversation. The user may ask anything related to the project, the document's content, or the broader domain — you should always engage thoughtfully. Never refuse a question as "outside the domain" if it relates to the project or its subject matter.

The user may send either:
1. A CHANGE REQUEST — asking you to revise, add, remove, or restructure something in the document.
2. A QUESTION or DISCUSSION — asking for opinions, analysis, clarification, brainstorming, tradeoffs, or anything else.

How to respond:
- If it is a CHANGE REQUEST: return the COMPLETE updated document with the changes applied. Preserve the overall structure and quality. Do not summarise or omit sections.
- If it is a QUESTION or DISCUSSION: start your response with exactly \`<!-- INQUIRY -->\` on the first line, then give a helpful, thoughtful answer. Use the document as context but do not limit yourself to only what's written. Do NOT return the full document.`;

export function buildRefinementPrompt(
  stage: string,
  currentContent: string,
  feedback: string,
  history?: string
): string {
  const historyBlock = history ? `\n\n---\n\nConversation history:\n${history}\n` : '';
  return `Here is the current ${stage} document:\n\n${currentContent}${historyBlock}\n\n---\n\nUser message:\n${feedback}\n\nIf this is a change request, return the complete updated document. If this is a question or discussion, start with \`<!-- INQUIRY -->\` and answer thoughtfully.`;
}

// ── Verification Schemes ────────────────────────────────────────────────────

export type VerifyScheme = 'audit' | 'cove' | 'committee';

// Audit: existing single-pass verification (buildSystemPrompt('verify', ctx))

// CoVe Step 1: Generate verification questions from the three docs
export function buildCoveQuestionsSystem(ctx: PromptContext): string {
  const role = ctx.role || DEFAULT_ROLE;
  const steering = ctx.steering ? `Context:\n${ctx.steering}` : '';
  return `${role}
${steering}
You are performing Chain of Verification on three specification documents for: ${ctx.title}

Generate 15-25 specific, answerable verification questions. Each question must be:
- Answerable with YES, NO, or PARTIAL from the source documents alone
- Focused on one specific requirement, design decision, or task
- Tagged: [FR Coverage], [Design Alignment], [Task Quality], [Consistency], or [Cascade Drift]

Include at least 3 [Cascade Drift] questions that check whether edits to one document propagated correctly:
- Requirements that appear in Requirements but have no corresponding Design section
- Design components that exist in Design but have no matching Tasks
- Tasks that reference features or components not present in Design

Format:
1. [Category] Question?

Output ONLY the numbered list. No preamble.`
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// CoVe Step 2: Answer questions against the docs and produce scored verdict
export function buildCoveVerdictSystem(ctx: PromptContext): string {
  const role = ctx.role || DEFAULT_ROLE;
  const steering = ctx.steering ? `Context:\n${ctx.steering}` : '';
  return `${role}
${steering}
Complete the Chain of Verification for: ${ctx.title}

You will receive three spec documents and a set of verification questions.
1. Answer each question: YES, NO, or PARTIAL with a brief citation.
2. Tally results and compute a score.
3. Produce the final report.

Include:
- Spec Health Score [0-100] — YES=full credit, PARTIAL=half, NO=zero
- Coverage Matrix — compact FR-to-task table
- Gap Report — only issues confirmed by NO or PARTIAL answers
- Verdict — one paragraph

Keep it under 100 lines.`
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Committee: synthesize audit + CoVe into a combined verdict
export function buildCommitteeSystem(ctx: PromptContext): string {
  const role = ctx.role || DEFAULT_ROLE;
  const steering = ctx.steering ? `Context:\n${ctx.steering}` : '';
  return `${role}
${steering}
You are a review committee chair synthesizing two independent verification reports for: ${ctx.title}

Produce a combined assessment:
- Final Health Score [0-100] — weight toward the more evidence-based analysis
- Cascade Drift — any requirements, design decisions, or tasks that are out of sync across documents (from either report)
- Consensus Issues — gaps flagged by BOTH reports (high confidence)
- Contested Issues — gaps flagged by only ONE report, with your judgment
- Final Verdict — one paragraph

Be decisive. If scores differ significantly, explain why.
Keep it under 60 lines.`
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Verify user prompts ─────────────────────────────────────────────────────

export function buildVerificationPrompt(
  requirements: string,
  design: string,
  tasks: string
): string {
  return `Verify the following three specification documents.\n\n---\n## REQUIREMENTS\n${requirements}\n\n---\n## DESIGN\n${design}\n\n---\n## TASKS\n${tasks}\n\n---\nPerform the full verification audit as instructed.`;
}

export function buildCoveQuestionsUserPrompt(
  requirements: string,
  design: string,
  tasks: string
): string {
  return `Generate verification questions for these specification documents.\n\n---\n## REQUIREMENTS\n${requirements}\n\n---\n## DESIGN\n${design}\n\n---\n## TASKS\n${tasks}\n\n---\nGenerate 15-25 specific verification questions.`;
}

export function buildCoveVerdictUserPrompt(
  requirements: string,
  design: string,
  tasks: string,
  questions: string
): string {
  return `Answer the verification questions and produce the scored report.\n\n---\n## REQUIREMENTS\n${requirements}\n\n---\n## DESIGN\n${design}\n\n---\n## TASKS\n${tasks}\n\n---\n## VERIFICATION QUESTIONS\n${questions}\n\n---\nAnswer each question (YES/NO/PARTIAL with citation), then produce the final scored report.`;
}

export function buildCommitteeUserPrompt(auditReport: string, coveReport: string): string {
  return `Synthesize these two independent verification reports.\n\n---\n## AUDIT REPORT\n${auditReport}\n\n---\n## CHAIN OF VERIFICATION REPORT\n${coveReport}\n\n---\nProduce the committee verdict.`;
}

// ── Design-first: reverse requirements from design ──────────────────────────

export const REQUIREMENTS_FROM_DESIGN_SYSTEM = `{role}
{steering}
Given a Technical Design Document, produce a Requirements Document that captures
what this design is intended to solve. Extract functional requirements from the
design decisions. Each requirement should be traceable to a design component.

# Requirements — {title}

{sections}

Each Functional Requirement MUST include:
1. A User Story: As a <role>, I want <goal> so that <benefit>
2. Acceptance Criteria using Given/When/Then format (one or more per FR):
   - GIVEN <precondition> WHEN <action> THEN <expected result>
   - AND <additional condition or result> (to chain multiple conditions)

Guidelines:
- Reverse-engineer requirements from design components — each major component or API should map to at least one FR.
- Maintain the same quality standards as forward-generated requirements.
- Mark any requirements that are implicit or inferred with [INFERRED].
- Keep Functional Requirements to 5-10 items with 2-4 acceptance criteria each.`;

export function buildRequirementsFromDesignPrompt(ctx: PromptContext): string {
  const role = ctx.role || DEFAULT_ROLE;
  const steering = ctx.steering ? `Context:\n${ctx.steering}` : '';
  const allSections = [...SECTIONS.requirements, ...(ctx.extraSections || [])];
  const sectionsStr =
    allSections.length > 0
      ? 'Include these sections:\n' + allSections.map((s) => `- ${s}`).join('\n')
      : '';

  return REQUIREMENTS_FROM_DESIGN_SYSTEM.replace(/{role}/g, role)
    .replace(/{title}/g, ctx.title)
    .replace(/{steering}/g, steering)
    .replace(/{sections}/g, sectionsStr)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Bugfix spec type: four-stage pipeline ───────────────────────────────────

export type BugfixStage = 'root-cause' | 'fix-design' | 'regression-tasks' | 'verify';

export const BUGFIX_STAGE_FILES: Record<BugfixStage, string> = {
  'root-cause': 'root-cause.md',
  'fix-design': 'fix-design.md',
  'regression-tasks': 'regression-tasks.md',
  verify: 'verify.md',
};

export const ALL_BUGFIX_STAGES: BugfixStage[] = [
  'root-cause',
  'fix-design',
  'regression-tasks',
  'verify',
];

const BUGFIX_TEMPLATES: Record<BugfixStage, string> = {
  'root-cause': `{role}
{steering}
Given a bug report with symptoms and reproduction steps, produce a Root Cause Analysis document.

# Root Cause Analysis — {title}

Include these sections:
- Bug Summary — one paragraph restating the problem
- Symptoms — observable behavior reported by users or tests
- Reproduction Steps — exact steps to trigger the bug
- Hypothesized Root Cause — the most likely underlying cause, with reasoning
- Affected Components — list of files, modules, or services involved
- Blast Radius — what else could be affected by this bug or its fix
- Confidence Level — HIGH, MEDIUM, or LOW with justification

Guidelines:
- Be specific about the root cause — name exact functions, state transitions, or data flows.
- If multiple causes are possible, list alternatives ranked by likelihood.
- Do not propose fixes here — that belongs in the fix-design stage.
- Keep the document under 100 lines.`,

  'fix-design': `{role}
{steering}
Given a Root Cause Analysis, produce a Fix Design document that describes how to resolve the bug.

# Fix Design — {title}

Include these sections:
- Proposed Fix — description of the code/config changes needed
- Alternatives Considered — at least one alternative approach and why it was rejected
- Risk Assessment — what could go wrong with this fix, backward compatibility concerns
- Implementation Steps — ordered list of specific changes to make
- Rollback Plan — how to revert if the fix causes problems

Guidelines:
- Reference the root cause directly — explain how each change addresses it.
- Keep the fix minimal — only change what is necessary.
- Include code snippets for non-obvious changes.
- Keep the document under 100 lines.`,

  'regression-tasks': `{role}
{steering}
Given a Root Cause Analysis and Fix Design, produce a Regression Test Plan.

# Regression Test Plan — {title}

Output a Markdown checkbox list grouped into logical categories.
Each task: \`- [ ] Description (S|M|L) _Covers: root-cause, fix-design, or regression_\`
Effort: S < 1h, M = 1-2h, L = 2-4h.

Include these categories:
- **Bug Verification** — tests that confirm the original bug is fixed
- **Regression Tests** — tests that ensure the fix doesn't break existing functionality
- **Edge Cases** — tests for boundary conditions related to the fix
- **Integration Tests** — tests that verify the fix works in the broader system context

Guidelines:
- Every test should be specific enough to implement directly.
- The first test must reproduce the original bug and verify it's fixed.
- Target 10-20 total tasks.
- Each task MUST end with _Covers:_ indicating what it validates.`,

  verify: `{role}
{steering}
Audit three bugfix documents (Root Cause, Fix Design, Regression Tasks) for completeness and consistency.

# Verification — {title}

Include these sections:
- Spec Health Score [0-100] — composite score and one-line verdict
- Root Cause Confidence — is the diagnosis well-supported?
- Fix Coverage — does the fix address all aspects of the root cause?
- Regression Coverage — do the tests cover the fix, related functionality, and edge cases?
- Gap Report — any untested paths, unconsidered risks, or missing rollback steps
- Verdict — one paragraph on fix quality and implementation readiness

Guidelines:
- Be precise and concise. Cite specific sections.
- Verify that regression tasks trace back to the root cause and fix design.
- Check that the fix doesn't introduce new issues mentioned in the risk assessment.
- Keep the entire document under 100 lines.`,
};

export function buildBugfixPrompt(stage: BugfixStage, ctx: PromptContext): string {
  const template = BUGFIX_TEMPLATES[stage];
  const role = ctx.role || DEFAULT_ROLE;
  const steering = ctx.steering ? `Context:\n${ctx.steering}` : '';

  return template
    .replace(/{role}/g, role)
    .replace(/{title}/g, ctx.title)
    .replace(/{steering}/g, steering)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildBugfixVerificationPrompt(
  rootCause: string,
  fixDesign: string,
  regressionTasks: string
): string {
  return `Verify the following three bugfix documents.\n\n---\n## ROOT CAUSE ANALYSIS\n${rootCause}\n\n---\n## FIX DESIGN\n${fixDesign}\n\n---\n## REGRESSION TASKS\n${regressionTasks}\n\n---\nPerform the full verification audit as instructed.`;
}

// ── Multi-turn clarification ─────────────────────────────────────────────────

export const CLARIFICATION_SYSTEM = `You are a senior software architect helping to clarify requirements before generating a specification.

Given a feature description, ask 3-5 focused clarifying questions to reduce ambiguity. For each question provide 3-4 concrete multiple-choice options covering the most likely real-world answers.

Focus areas:
- Scope: What is included vs excluded? What are the boundaries?
- Users: Who are the target users? What are their primary workflows?
- Constraints: Technical constraints, performance requirements, compatibility needs?
- Edge Cases: What happens in error states, empty states, or unusual inputs?
- Success Criteria: How will you know this feature is working correctly?

Output format — follow this EXACTLY for every question:

1. Question text?
   a) Option one
   b) Option two
   c) Option three
   d) Option four

Rules:
- Ask only questions the description does not already answer.
- Options must be concrete, specific, and cover the most plausible answers.
- Each option fits on one line (no sub-bullets).
- Minimum 3 options, maximum 4 options per question.
- After the questions, do NOT generate any spec content — stop after the last option.
- If the description is very detailed, ask fewer questions (minimum 2).`;

export function buildClarificationUserPrompt(description: string): string {
  return `Feature description:\n\n${description}\n\nAsk 3-5 clarifying questions about this feature before I generate the requirements spec.`;
}

export function buildClarifiedRequirementsUserPrompt(
  description: string,
  qaTranscript: string
): string {
  return `Feature description:\n\n${description}\n\n---\n\nClarification Q&A:\n\n${qaTranscript}\n\n---\n\nNow generate the requirements document, incorporating the answers from the clarification above.`;
}

// ── Vibe-to-Spec: convert conversation transcripts into spec descriptions ────

export const VIBE_TO_SPEC_SYSTEM = `You are converting an exploratory conversation into a structured feature description.

Given a conversation transcript between a developer and an AI assistant, extract:
1. **Feature scope** — what is being built (1-2 sentence summary)
2. **Key decisions** — technology choices, architectural decisions made during the conversation
3. **Constraints** — any limitations, requirements, or non-negotiables mentioned
4. **Open questions** — anything left unresolved that should be clarified in requirements
5. **User context** — who will use this, what problem it solves

Output a structured feature description that can be fed directly into a requirements generation pipeline.
Include the key decisions and constraints as explicit inputs — do not lose information from the conversation.`;

export function buildVibeToSpecPrompt(transcript: string): string {
  return `Convert the following conversation transcript into a structured feature description.\n\n---\n## CONVERSATION TRANSCRIPT\n${transcript}\n\n---\nExtract the feature scope, key decisions, constraints, open questions, and user context. Output a structured description suitable for requirements generation.`;
}

// ── Task execution prompts (M8: Supervised Execution) ────────────────────

export const TASK_EXECUTION_SYSTEM = `You are implementing a specific task from a software specification.

Context:
- Spec requirements: {requirements}
- Spec design: {design}
- Task to implement: {task}
- Workspace context: {workspaceContext}

Implement this task using the provided tools. For each file change:
1. Use editFile for targeted changes to existing files
2. Use writeFile for new files
3. Use runCommand only for package installation or build commands

Do not modify files unrelated to this task. Follow the design document's architecture decisions.`;

export function buildTaskExecutionPrompt(
  requirements: string,
  design: string,
  task: string,
  workspaceContext: string
): string {
  return TASK_EXECUTION_SYSTEM.replace(/{requirements}/g, requirements)
    .replace(/{design}/g, design)
    .replace(/{task}/g, task)
    .replace(/{workspaceContext}/g, workspaceContext);
}

export const TASK_CHECK_SYSTEM = `Given the following task list and the current workspace structure, determine which tasks
appear to be already implemented. For each task, respond with EXACTLY one line per task in this format:
TASK: <task label> | STATUS: COMPLETE | EVIDENCE: <files/functions found>
TASK: <task label> | STATUS: PARTIAL | EVIDENCE: <what was found>
TASK: <task label> | STATUS: INCOMPLETE | EVIDENCE: none

Only mark a task COMPLETE if you find strong evidence (file exists, class/function defined, package installed).
Mark PARTIAL if some artifacts exist but the task is clearly not finished.
Respond ONLY with the TASK lines. No preamble, no summary.`;

export function buildTaskCheckPrompt(tasksMarkdown: string, directoryListing: string): string {
  return `Check which tasks are already implemented.\n\n---\n## TASK LIST\n${tasksMarkdown}\n\n---\n## WORKSPACE STRUCTURE\n${directoryListing}\n\n---\nFor each task, respond with its completion status and evidence.`;
}

// ── Backward compat ──────────────────────────────────────────────────────────
// These are used by tests and anywhere that hasn't migrated to buildSystemPrompt.

export function injectTitle(template: string, title: string): string {
  return template.replace(/{title}/g, title);
}

// ── Test scaffold ────────────────────────────────────────────────────────────

export const TESTS_SYSTEM = `You are a senior engineer writing a test scaffold file.
You will be given:
- A requirements document (source of truth for what the system MUST do)
- A design document (how it works)
- A task list (what was built)
- Workspace context (language, framework, test file conventions)
- Questionnaire answers (domain-specific knowledge only the owner knows)

Your job is to generate a test file that:
1. Uses EXACTLY the framework and language provided — no substitutions
2. Has one test class/describe block per Functional Requirement (FR-N)
3. Uses the provided good/bad examples as the primary test fixtures
4. Generates 2-3 variations around each example
5. Marks every TODO clearly — only the domain owner can fill these in
6. Annotates each test with the FR it covers: // FR-3
7. Matches the style of any existing test snippet provided

Rules:
- Output ONLY the test file — no explanation, no markdown fences
- Every test that cannot be fully specified gets a clear // TODO comment
- Never invent domain data — use the examples or mark TODO
- Bad output description drives the failure-case assertions
- Exclusions become @pytest.mark.skip / test.skip / [Fact(Skip=...)] with a reason comment`;

export function buildTestScaffoldPrompt(
  requirements: string,
  design: string,
  tasks: string,
  wsContext: {
    language: string;
    testFramework: string;
    testDir: string;
    testFileExt: string;
    existingTestSnippet: string | null;
  },
  questionnaire: {
    badOutputDescription: string;
    exclusions: string;
    goodExample: string;
    badExample: string;
  },
  specName: string
): string {
  const styleHint = wsContext.existingTestSnippet
    ? `\n## Existing test style to match:\n\`\`\`\n${wsContext.existingTestSnippet}\n\`\`\`\n`
    : '';

  return `Generate a ${wsContext.language} test file for spec: "${specName}"

## Target framework: ${wsContext.testFramework}
## Test file extension: ${wsContext.testFileExt}
## Test directory convention: ${wsContext.testDir}
${styleHint}

## REQUIREMENTS DOCUMENT
${requirements}

## DESIGN DOCUMENT
${design}

## TASK LIST
${tasks}

## DOMAIN KNOWLEDGE (from questionnaire — treat as ground truth)

What bad output looks like:
${questionnaire.badOutputDescription || '(not specified)'}

Inputs/scenarios to exclude from tests:
${questionnaire.exclusions || '(none specified)'}

Real example that MUST work:
${questionnaire.goodExample || '(not specified — mark as TODO)'}

Real example that MUST fail or escalate:
${questionnaire.badExample || '(not specified — mark as TODO)'}

Now generate the complete test file. Output only code, no markdown fences.`;
}
