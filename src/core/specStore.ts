import * as path from 'path';
import * as fs from 'fs';
import type { Dirent } from 'fs';

export type Stage = 'requirements' | 'design' | 'tasks' | 'verify';

export const ALL_STAGES: Stage[] = ['requirements', 'design', 'tasks', 'verify'];

const STAGE_FILES: Record<Stage, string> = {
  requirements: 'requirements.md',
  design: 'design.md',
  tasks: 'tasks.md',
  verify: 'verify.md',
};

const CONFIG_FILE = 'spec.config.json';
const PROGRESS_FILE = '_progress.json';
const PROMPTS_DIR = '_prompts';

export interface SpecInfo {
  name: string;
  folderPath: string;
  stages: Partial<Record<Stage, string>>;
  progress?: TaskProgress;
}

export interface TaskItem {
  id: string;
  label: string;
  indent: number;
  checked: boolean;
  line: number;
}

export interface TaskProgress {
  total: number;
  done: number;
  checked: number;
  skipped: number;
  items: Record<string, TaskSelectionState>;
  updatedAt: string;
}

export type TaskSelectionState = 'done' | 'checked' | 'empty';

export interface TestQuestionnaire {
  badOutputDescription: string;
  exclusions: string;
  goodExample: string;
  badExample: string;
}

// ── OpenSpec prompt loading ───────────────────────────────────────────────────

function readFileOrNull(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8').trim() || null;
}

export function loadCustomPrompt(specsRoot: string, specName: string, stage: Stage): string | null {
  const specPromptPath = path.join(specsRoot, specName, PROMPTS_DIR, `${stage}.md`);
  if (fs.existsSync(specPromptPath)) {
    return fs.readFileSync(specPromptPath, 'utf-8').trim();
  }
  const wsPromptPath = path.join(specsRoot, PROMPTS_DIR, `${stage}.md`);
  if (fs.existsSync(wsPromptPath)) {
    return fs.readFileSync(wsPromptPath, 'utf-8').trim();
  }
  return null;
}

export function loadSteering(specsRoot: string, specName: string): string | null {
  const parts: string[] = [];

  // 1. Scan .specs/steering/*.md (workspace conventions, sorted alphabetically)
  const steeringDir = path.join(specsRoot, 'steering');
  if (fs.existsSync(steeringDir)) {
    const files = (fs.readdirSync(steeringDir, { withFileTypes: true }) as Dirent[])
      .filter((f: Dirent) => f.isFile() && f.name.endsWith('.md'))
      .map((f: Dirent) => f.name)
      .sort();
    for (const file of files) {
      const content = readFileOrNull(path.join(steeringDir, file));
      if (content) parts.push(content);
    }
  }

  // 2. Legacy workspace-wide _steering.md
  const ws = readFileOrNull(path.join(specsRoot, '_steering.md'));
  if (ws) parts.push(ws);

  // 3. Spec-specific _steering.md
  const spec = readFileOrNull(path.join(specsRoot, specName, '_steering.md'));
  if (spec) parts.push(spec);

  return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
}

export function loadRole(specsRoot: string, specName: string): string | null {
  const spec = readFileOrNull(path.join(specsRoot, specName, '_role.md'));
  if (spec) return spec;
  const ws = readFileOrNull(path.join(specsRoot, '_role.md'));
  if (ws) return ws;
  return null;
}

export function loadExtraSections(specsRoot: string, specName: string, stage: Stage): string[] {
  const filePath = path.join(specsRoot, specName, '_sections', `${stage}.md`);
  const content = readFileOrNull(filePath);
  if (!content) return [];
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

export function hasCustomPrompts(specsRoot: string, specName: string): boolean {
  const dir = path.join(specsRoot, specName, PROMPTS_DIR);
  if (!fs.existsSync(dir)) return false;
  return (fs.readdirSync(dir, { withFileTypes: true }) as Dirent[]).some((f: Dirent) =>
    f.name.endsWith('.md')
  );
}

export function scaffoldCustomPrompts(specsRoot: string, specName: string): void {
  const dir = path.join(specsRoot, specName, PROMPTS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const readme = `# Custom Prompts (OpenSpec Override)\n\nDrop .md files here named requirements.md, design.md, tasks.md, or verify.md\nto override the nSpec system prompt for each stage.\n\nUse {title} as a placeholder for the spec name.\nA _prompts/ folder at .specs/_prompts/ applies workspace-wide.\n`;
  if (!fs.existsSync(path.join(dir, 'README.md'))) {
    fs.writeFileSync(path.join(dir, 'README.md'), readme, 'utf-8');
  }
}

/**
 * Writes a tree of annotated example files into .specs/examples/.
 * Shows users how to customize nSpec behavior using steering files,
 * role overrides, prompt overrides, and extra sections — without touching
 * any live spec data.
 */
export function scaffoldExamples(specsRoot: string): string[] {
  const examplesDir = path.join(specsRoot, 'examples');
  const steeringDir = path.join(examplesDir, 'steering');
  const perSpecDir = path.join(examplesDir, 'per-spec');
  const promptsDir = path.join(perSpecDir, '_prompts');
  const sectionsDir = path.join(perSpecDir, '_sections');

  for (const dir of [steeringDir, promptsDir, sectionsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const written: string[] = [];

  function write(filePath: string, content: string) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8');
      written.push(path.relative(specsRoot, filePath));
    }
  }

  // ── README ──────────────────────────────────────────────────────────────────
  write(
    path.join(examplesDir, 'README.md'),
    `# nSpec Customization Examples

This folder contains ready-to-use example files for every nSpec customization hook.
Each file is annotated with instructions. Copy the ones you need to the paths shown.

## Workspace-wide steering (applies to every spec)

| Example file | Copy to |
|---|---|
| \`steering/product.md\` | \`.specs/steering/product.md\` |
| \`steering/tech.md\` | \`.specs/steering/tech.md\` |

Steering files are injected into every AI prompt automatically.
Add as many as you like — they are loaded alphabetically.

## Per-spec customization (applies to one spec)

| Example file | Copy to |
|---|---|
| \`per-spec/_steering.md\` | \`.specs/<name>/_steering.md\` |
| \`per-spec/_role.md\` | \`.specs/<name>/_role.md\` |
| \`per-spec/_prompts/requirements.md\` | \`.specs/<name>/_prompts/requirements.md\` |
| \`per-spec/_sections/tasks.md\` | \`.specs/<name>/_sections/tasks.md\` |

Replace \`<name>\` with your spec's folder name (e.g. \`user-auth\`).

## Tip

Run **nSpec: Setup Steering Files** from the Command Palette to auto-generate
\`product.md\`, \`tech.md\`, and \`structure.md\` steering files from your workspace.
`
  );

  // ── Workspace steering: product.md ─────────────────────────────────────────
  write(
    path.join(steeringDir, 'product.md'),
    `# Product Context
<!-- Copy this file to .specs/steering/product.md -->
<!-- It is injected into every AI prompt as project background. -->

## What we're building

<!-- Describe your product in 1–3 sentences. -->
Example Corp builds a SaaS platform for construction project managers.
Our users track bids, timelines, and subcontractor workflows.

## Target users

- Project managers at mid-size construction firms (10–200 employees)
- Field supervisors who need mobile-friendly views
- Estimators who generate bid documents

## Business rules

- All monetary values are in USD; support multi-currency is out of scope.
- Projects are owned by a single organization; cross-org sharing is not supported.
- Compliance: SOC 2 Type II controls apply to all data storage.
`
  );

  // ── Workspace steering: tech.md ─────────────────────────────────────────────
  write(
    path.join(steeringDir, 'tech.md'),
    `# Technology Stack
<!-- Copy this file to .specs/steering/tech.md -->
<!-- Keeps AI suggestions aligned with your actual stack. -->

## Languages & runtimes

- TypeScript 5.x (strict mode)
- Node.js 20 LTS

## Frameworks & libraries

- Backend: Express 4, Zod for validation, Drizzle ORM
- Frontend: React 18, Vite, Tailwind CSS
- Testing: Vitest, Playwright for e2e

## Conventions

- File naming: kebab-case for files, PascalCase for components/classes
- Errors: throw typed Error subclasses; never swallow exceptions silently
- API responses: \`{ data, error, meta }\` envelope
- No \`any\` — use \`unknown\` + type narrowing instead

## Infrastructure

- Deployed to AWS (ECS Fargate + RDS Postgres)
- CI/CD: GitHub Actions
- Secrets: AWS Secrets Manager (never in env files committed to git)
`
  );

  // ── Per-spec steering ───────────────────────────────────────────────────────
  write(
    path.join(perSpecDir, '_steering.md'),
    `# Spec-Specific Context
<!-- Copy this file to .specs/<name>/_steering.md -->
<!-- Adds domain knowledge scoped to a single spec. -->
<!-- Stacks on top of workspace-wide steering. -->

## Domain context for this spec

This spec covers the **billing module**.

- Payments are processed via Stripe; we do not store raw card data.
- Invoices are immutable once issued — corrections use credit notes.
- All billing events must be audit-logged with user ID, timestamp, and delta.

## Constraints

- Must not introduce new direct database writes from the frontend.
- Pricing logic lives in \`src/billing/pricing.ts\` — do not duplicate it.
`
  );

  // ── Per-spec role override ──────────────────────────────────────────────────
  write(
    path.join(perSpecDir, '_role.md'),
    `# AI Role Override
<!-- Copy this file to .specs/<name>/_role.md -->
<!-- Replaces the default "senior software engineer" persona for this spec. -->
<!-- Useful for domain-specific voice (e.g. security, data science, mobile). -->

You are a senior security engineer with 10 years of experience in payment systems
and PCI-DSS compliance. You write precise, threat-modeled requirements and flag
any design choice that could expose cardholder data or violate compliance rules.
When reviewing tasks, you call out missing audit trails and access-control gaps.
`
  );

  // ── Per-spec prompt override ────────────────────────────────────────────────
  write(
    path.join(promptsDir, 'requirements.md'),
    `# Requirements Prompt Override
<!-- Copy this file to .specs/<name>/_prompts/requirements.md -->
<!-- Completely replaces the nSpec requirements-generation system prompt. -->
<!-- Use {title} as a placeholder for the spec name. -->
<!-- For workspace-wide override, copy to .specs/_prompts/requirements.md instead. -->

You are a business analyst writing formal software requirements.

Given the feature description for **{title}**, produce a requirements document with:

1. A one-paragraph **Executive Summary**
2. **Functional Requirements** (FR-1, FR-2, …) in Given/When/Then format
3. **Non-Functional Requirements** covering performance, security, and accessibility
4. **Out of Scope** — explicitly list what is NOT included
5. **Open Questions** — unresolved decisions that need stakeholder input

Be concise. Each FR should fit in 3–5 lines. Flag any ambiguity rather than
making assumptions.
`
  );

  // ── Per-spec extra sections ─────────────────────────────────────────────────
  write(
    path.join(sectionsDir, 'tasks.md'),
    `# Extra Sections for Tasks Stage
<!-- Copy this file to .specs/<name>/_sections/tasks.md -->
<!-- Each non-blank, non-heading line is appended as an extra output section. -->
<!-- The AI generates content for each section you list here. -->

Definition of Done
Testing Checklist
Rollback Plan
`
  );

  return written;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function listSpecs(specsRoot: string): SpecInfo[] {
  if (!fs.existsSync(specsRoot)) return [];

  return (fs.readdirSync(specsRoot, { withFileTypes: true }) as Dirent[])
    .filter((d: Dirent) => d.isDirectory())
    .map((d: Dirent) => {
      const folderPath = path.join(specsRoot, d.name);
      const stages: Partial<Record<Stage, string>> = {};
      for (const [stage, file] of Object.entries(STAGE_FILES) as [Stage, string][]) {
        const filePath = path.join(folderPath, file);
        if (fs.existsSync(filePath)) {
          stages[stage as Stage] = fs.readFileSync(filePath, 'utf-8');
        }
      }
      const progress = readTaskProgress(specsRoot, d.name);
      return { name: d.name, folderPath, stages, progress: progress ?? undefined };
    });
}

export function readStage(specsRoot: string, specName: string, stage: Stage): string | null {
  const filePath = path.join(specsRoot, specName, STAGE_FILES[stage]);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

export function writeStage(
  specsRoot: string,
  specName: string,
  stage: Stage,
  content: string
): void {
  const dir = path.join(specsRoot, specName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, STAGE_FILES[stage]), content, 'utf-8');
  writeConfig(dir);
}

export function createSpecFolder(
  specsRoot: string,
  specName: string,
  mode?: GenerationMode,
  template?: string
): string {
  const dir = path.join(specsRoot, specName);
  fs.mkdirSync(dir, { recursive: true });
  writeConfig(dir, mode || 'requirements-first', template);
  return dir;
}

// ── Bugfix stage CRUD ─────────────────────────────────────────────────────────

const BUGFIX_STAGE_FILES: Record<string, string> = {
  'root-cause': 'root-cause.md',
  'fix-design': 'fix-design.md',
  'regression-tasks': 'regression-tasks.md',
  verify: 'verify.md',
};

export const ALL_BUGFIX_STAGES = [
  'root-cause',
  'fix-design',
  'regression-tasks',
  'verify',
] as const;

export function readBugfixStage(specsRoot: string, specName: string, stage: string): string | null {
  const file = BUGFIX_STAGE_FILES[stage];
  if (!file) return null;
  const filePath = path.join(specsRoot, specName, file);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

export function writeBugfixStage(
  specsRoot: string,
  specName: string,
  stage: string,
  content: string
): void {
  const file = BUGFIX_STAGE_FILES[stage];
  if (!file) return;
  const dir = path.join(specsRoot, specName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), content, 'utf-8');
}

// ── Template scaffolding ──────────────────────────────────────────────────────

export const AVAILABLE_TEMPLATES = [
  'rest-api',
  'game-feature',
  'ml-experiment',
  'cli-tool',
  'library-sdk',
] as const;
export type TemplateName = (typeof AVAILABLE_TEMPLATES)[number];

export interface TemplateInfo {
  id: TemplateName;
  name: string;
  description: string;
  sections: Record<string, string[]>;
}

export const TEMPLATE_REGISTRY: TemplateInfo[] = [
  {
    id: 'rest-api',
    name: 'REST API',
    description: 'CRUD endpoints, auth, validation',
    sections: {
      requirements: ['API Routes', 'Error Codes', 'Rate Limits'],
      design: ['Endpoint Specifications', 'Authentication Flow', 'Request/Response Schemas'],
      tasks: [],
      verify: ['API Coverage Matrix'],
    },
  },
  {
    id: 'game-feature',
    name: 'Game Feature',
    description: 'Player-facing feature for a game',
    sections: {
      requirements: ['Game Mechanics', 'Player Experience', 'Balance'],
      design: ['Game Loop Integration', 'State Management', 'Asset Requirements'],
      tasks: [],
      verify: ['Gameplay Coverage'],
    },
  },
  {
    id: 'ml-experiment',
    name: 'ML Experiment',
    description: 'Model training / evaluation pipeline',
    sections: {
      requirements: ['Data Requirements', 'Metrics', 'Baselines'],
      design: ['Model Architecture', 'Training Pipeline', 'Evaluation Strategy'],
      tasks: [],
      verify: ['Experiment Reproducibility'],
    },
  },
  {
    id: 'cli-tool',
    name: 'CLI Tool',
    description: 'Command-line application',
    sections: {
      requirements: ['Commands', 'Flags', 'Output Format'],
      design: ['Command Parser', 'Plugin Architecture', 'Configuration'],
      tasks: [],
      verify: ['Command Coverage'],
    },
  },
  {
    id: 'library-sdk',
    name: 'Library / SDK',
    description: 'Reusable package with public API',
    sections: {
      requirements: ['Public API', 'Compatibility', 'Versioning'],
      design: ['Module Structure', 'Type System', 'Error Handling'],
      tasks: [],
      verify: ['API Surface Coverage'],
    },
  },
];

export function getTemplateInfo(templateId: string): TemplateInfo | null {
  return TEMPLATE_REGISTRY.find((t) => t.id === templateId) || null;
}

export function scaffoldTemplate(specsRoot: string, specName: string, templateId: string): void {
  const template = getTemplateInfo(templateId);
  if (!template) return;

  const specDir = path.join(specsRoot, specName);

  // Write _steering.md with domain context
  const steeringContent = `# ${template.name} Spec\n\nThis spec uses the **${template.name}** template (${template.description}).\nGenerated prompts will include domain-specific sections for this type of project.\n`;
  fs.writeFileSync(path.join(specDir, '_steering.md'), steeringContent, 'utf-8');

  // Write _sections/ files with template-specific sections
  const sectionsDir = path.join(specDir, '_sections');
  fs.mkdirSync(sectionsDir, { recursive: true });
  for (const [stage, sections] of Object.entries(template.sections)) {
    if (sections.length > 0) {
      fs.writeFileSync(path.join(sectionsDir, `${stage}.md`), sections.join('\n'), 'utf-8');
    }
  }

  // Write _role.md with template-appropriate role
  const roleMap: Record<string, string> = {
    'rest-api':
      'You are a senior backend engineer specializing in RESTful API design and web services.',
    'game-feature':
      'You are a senior game designer and engineer with expertise in player experience and game mechanics.',
    'ml-experiment':
      'You are a senior ML engineer specializing in experiment design, model evaluation, and reproducible research.',
    'cli-tool':
      'You are a senior developer specializing in command-line tools, developer experience, and Unix philosophy.',
    'library-sdk':
      'You are a senior library author specializing in API design, backward compatibility, and developer ergonomics.',
  };
  if (roleMap[templateId]) {
    fs.writeFileSync(path.join(specDir, '_role.md'), roleMap[templateId], 'utf-8');
  }
}

export type SpecType = 'feature' | 'bugfix';
export type GenerationMode = 'requirements-first' | 'design-first' | 'bugfix';

export interface VibeContext {
  transcript: string;
  extractedDescription: string;
  generatedAt: string;
}

/** Requirements format: Given/When/Then (default) or EARS (WHEN/IF … THE SYSTEM SHALL). */
export type RequirementsFormat = 'given-when-then' | 'ears';

export interface SpecConfig {
  generationMode: GenerationMode;
  specType?: SpecType;
  template?: string;
  vibeContext?: VibeContext;
  /** When true, design stage is kept light and inferred from existing codebase/context. */
  lightDesign?: boolean;
  /** Requirements format: default Given/When/Then or EARS. */
  requirementsFormat?: RequirementsFormat;
  version: string;
}

export function readConfig(specsRoot: string, specName: string): SpecConfig | null {
  const configPath = path.join(specsRoot, specName, CONFIG_FILE);
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeSpecConfig(specsRoot: string, specName: string, config: SpecConfig): void {
  const dir = path.join(specsRoot, specName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(config, null, 2), 'utf-8');
}

// ── Workspace-level config ────────────────────────────────────────────────────

const WORKSPACE_CONFIG_FILE = 'config.json';

/** Workspace-wide defaults applied to all specs unless overridden per spec. */
export interface WorkspaceConfig {
  /** Default requirements format for all specs in this workspace. */
  requirementsFormat?: RequirementsFormat;
}

export function loadWorkspaceConfig(specsRoot: string): WorkspaceConfig | null {
  const configPath = path.join(specsRoot, WORKSPACE_CONFIG_FILE);
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeWorkspaceConfig(specsRoot: string, config: WorkspaceConfig): void {
  fs.mkdirSync(specsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(specsRoot, WORKSPACE_CONFIG_FILE),
    JSON.stringify(config, null, 2),
    'utf-8'
  );
}

function writeConfig(dir: string, mode: GenerationMode = 'requirements-first', template?: string) {
  const configPath = path.join(dir, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    const config: SpecConfig = { generationMode: mode, version: '2.1' };
    if (mode === 'bugfix') config.specType = 'bugfix';
    if (template) config.template = template;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }
}

export function deleteSpec(specsRoot: string, specName: string): void {
  const dir = path.join(specsRoot, specName);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}

export function renameSpec(specsRoot: string, oldName: string, newName: string): boolean {
  const oldDir = path.join(specsRoot, oldName);
  const newDir = path.join(specsRoot, newName);
  if (!fs.existsSync(oldDir) || fs.existsSync(newDir)) return false;
  fs.renameSync(oldDir, newDir);
  return true;
}

// ── Task progress ─────────────────────────────────────────────────────────────

const CHECKBOX_RE = /^(\s*)-\s+\[([ xX])\]\s+(.+?)(?:\s+\([SMLX]+\))?$/;

export function parseTaskItems(markdown: string): TaskItem[] {
  const items: TaskItem[] = [];
  markdown.split('\n').forEach((line, index) => {
    const m = CHECKBOX_RE.exec(line);
    if (!m) return;
    const label = m[3].trim();
    items.push({
      id: stableId(label, index),
      label,
      indent: m[1].length,
      checked: m[2].toLowerCase() === 'x',
      line: index,
    });
  });
  return items;
}

export function readTaskProgress(specsRoot: string, specName: string): TaskProgress | null {
  const p = path.join(specsRoot, specName, PROGRESS_FILE);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      total?: number;
      done?: number;
      checked?: number;
      skipped?: number;
      items?: Record<string, TaskSelectionState | boolean>;
      updatedAt?: string;
    };
    const rawItems = parsed.items ?? {};
    const normalizedItems: Record<string, TaskSelectionState> = {};
    for (const [id, value] of Object.entries(rawItems)) {
      normalizedItems[id] = normalizeTaskSelectionState(value);
    }
    const stats = computeTaskStats(normalizedItems);
    return {
      total: parsed.total ?? Object.keys(normalizedItems).length,
      done: parsed.done ?? stats.done,
      checked: parsed.checked ?? stats.checked,
      skipped: parsed.skipped ?? stats.skipped,
      items: normalizedItems,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function writeTaskProgress(
  specsRoot: string,
  specName: string,
  progress: TaskProgress
): void {
  const dir = path.join(specsRoot, specName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PROGRESS_FILE), JSON.stringify(progress, null, 2), 'utf-8');
}

export function syncProgressFromMarkdown(
  specsRoot: string,
  specName: string,
  tasksMarkdown: string
): TaskProgress {
  const items = parseTaskItems(tasksMarkdown);
  const existing = readTaskProgress(specsRoot, specName);
  const itemMap: Record<string, TaskSelectionState> = {};
  for (const item of items) {
    const existingState = existing?.items[item.id];
    if (item.checked) {
      itemMap[item.id] = 'done';
      continue;
    }
    itemMap[item.id] = existingState ?? 'empty';
  }
  const stats = computeTaskStats(itemMap);
  const progress: TaskProgress = {
    total: items.length,
    done: stats.done,
    checked: stats.checked,
    skipped: stats.skipped,
    items: itemMap,
    updatedAt: new Date().toISOString(),
  };
  writeTaskProgress(specsRoot, specName, progress);
  return progress;
}

export function toggleTaskItem(
  specsRoot: string,
  specName: string,
  taskId: string
): TaskProgress | null {
  const progress = readTaskProgress(specsRoot, specName);
  if (!progress || !(taskId in progress.items)) return null;
  const current = progress.items[taskId];
  if (current === 'done') return progress;
  progress.items[taskId] = current === 'checked' ? 'empty' : 'checked';
  const stats = computeTaskStats(progress.items);
  progress.done = stats.done;
  progress.checked = stats.checked;
  progress.skipped = stats.skipped;
  progress.updatedAt = new Date().toISOString();
  writeTaskProgress(specsRoot, specName, progress);
  return progress;
}

export function setTaskItemSelection(
  specsRoot: string,
  specName: string,
  taskId: string,
  state: 'checked' | 'empty'
): TaskProgress | null {
  const progress = readTaskProgress(specsRoot, specName);
  if (!progress || !(taskId in progress.items)) return null;
  if (progress.items[taskId] === 'done') return progress;
  progress.items[taskId] = state;
  const stats = computeTaskStats(progress.items);
  progress.done = stats.done;
  progress.checked = stats.checked;
  progress.skipped = stats.skipped;
  progress.updatedAt = new Date().toISOString();
  writeTaskProgress(specsRoot, specName, progress);
  return progress;
}

export function setAllTaskSelections(
  specsRoot: string,
  specName: string,
  state: 'checked' | 'empty'
): TaskProgress | null {
  const progress = readTaskProgress(specsRoot, specName);
  if (!progress) return null;
  for (const id of Object.keys(progress.items)) {
    if (progress.items[id] === 'done') continue;
    progress.items[id] = state;
  }
  const stats = computeTaskStats(progress.items);
  progress.done = stats.done;
  progress.checked = stats.checked;
  progress.skipped = stats.skipped;
  progress.updatedAt = new Date().toISOString();
  writeTaskProgress(specsRoot, specName, progress);
  return progress;
}

function stableId(label: string, line: number): string {
  return `${label.slice(0, 32).replace(/\s+/g, '_').toLowerCase()}_${line}`;
}

function normalizeTaskSelectionState(value: TaskSelectionState | boolean | undefined): TaskSelectionState {
  if (value === 'done' || value === 'checked' || value === 'empty') return value;
  return value ? 'done' : 'empty';
}

function computeTaskStats(items: Record<string, TaskSelectionState>): {
  done: number;
  checked: number;
  skipped: number;
} {
  let done = 0;
  let checked = 0;
  let skipped = 0;
  for (const state of Object.values(items)) {
    if (state === 'done') done += 1;
    else if (state === 'checked') checked += 1;
    else skipped += 1;
  }
  return { done, checked, skipped };
}

// ── Task completion detection (M8: Supervised Execution) ──────────────────

export interface TaskCompletionResult {
  taskLabel: string;
  score: number; // 0.0 to 1.0
  evidence: string[];
}

/**
 * Scan the workspace for evidence that tasks are already implemented.
 * Returns a score (0-1) per task based on file existence, grep matches, and package checks.
 */
export function checkTaskCompletion(
  workspaceRoot: string,
  specsRoot: string,
  specName: string
): TaskCompletionResult[] {
  const tasksContent = readStage(specsRoot, specName, 'tasks');
  if (!tasksContent) return [];

  const items = parseTaskItems(tasksContent);
  const results: TaskCompletionResult[] = [];

  for (const item of items) {
    const evidence: string[] = [];
    let score = 0;

    // Extract signals from the task label
    const fileMatches = item.label.match(/`([^`]+\.\w+)`/g) || [];
    const classMatches = item.label.match(/`([A-Z][a-zA-Z]+)`/g) || [];
    const packageMatches = item.label.match(/`([a-z@][a-z0-9\-/@.]+)`/g) || [];

    // Check file existence
    for (const raw of fileMatches) {
      const name = raw.replace(/`/g, '');
      if (fileExistsRecursive(workspaceRoot, name)) {
        evidence.push(`File found: ${name}`);
        score += 0.4;
      }
    }

    // Check class/function names via simple grep
    for (const raw of classMatches) {
      const name = raw.replace(/`/g, '');
      if (grepWorkspace(workspaceRoot, name)) {
        evidence.push(`Symbol found: ${name}`);
        score += 0.3;
      }
    }

    // Check package.json dependencies
    for (const raw of packageMatches) {
      const name = raw.replace(/`/g, '');
      if (name.includes('/') || name.startsWith('@')) {
        if (checkPackageDep(workspaceRoot, name)) {
          evidence.push(`Package installed: ${name}`);
          score += 0.3;
        }
      }
    }

    results.push({ taskLabel: item.label, score: Math.min(score, 1.0), evidence });
  }

  return results;
}

function fileExistsRecursive(root: string, filename: string): boolean {
  // Check if filename looks like a path
  const asPath = path.join(root, filename);
  if (fs.existsSync(asPath)) return true;

  // Search top 3 levels for the basename
  const basename = path.basename(filename);
  return searchForFile(root, basename, 0, 3);
}

function searchForFile(dir: string, name: string, depth: number, maxDepth: number): boolean {
  if (depth > maxDepth) return false;
  const skip = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    '.next',
    'coverage',
    '__pycache__',
    '.venv',
    'venv',
    '.specs',
  ]);
  let entries: Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return false;
  }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    if (e.isFile() && e.name === name) return true;
    if (e.isDirectory() && searchForFile(path.join(dir, e.name), name, depth + 1, maxDepth))
      return true;
  }
  return false;
}

function grepWorkspace(root: string, symbol: string): boolean {
  const sourceExts = new Set(['.ts', '.js', '.tsx', '.jsx', '.py', '.cs', '.java', '.go', '.rs']);
  return grepDir(root, symbol, sourceExts, 0, 3);
}

function grepDir(
  dir: string,
  pattern: string,
  exts: Set<string>,
  depth: number,
  maxDepth: number
): boolean {
  if (depth > maxDepth) return false;
  const skip = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    '.next',
    'coverage',
    '__pycache__',
    '.venv',
    'venv',
    '.specs',
  ]);
  let entries: Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return false;
  }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isFile() && exts.has(path.extname(e.name).toLowerCase())) {
      try {
        const content = fs.readFileSync(full, 'utf-8');
        if (content.includes(pattern)) return true;
      } catch {
        /* skip unreadable files */
      }
    }
    if (e.isDirectory() && grepDir(full, pattern, exts, depth + 1, maxDepth)) return true;
  }
  return false;
}

function checkPackageDep(root: string, packageName: string): boolean {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
    return packageName in deps;
  } catch {
    return false;
  }
}

export function toFolderName(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'my-spec'
  );
}

// ── Workspace context for design/tasks injection ─────────────────────────────

const CONTEXT_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.specs',
  '.harness-runs',
]);

export function buildWorkspaceContext(workspaceRoot: string, specName: string): string {
  const sections: string[] = [];

  // 1. package.json key fields
  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const slim: Record<string, unknown> = {};
      if (pkg.name) slim.name = pkg.name;
      if (pkg.description) slim.description = pkg.description;
      if (pkg.dependencies) slim.dependencies = pkg.dependencies;
      if (pkg.devDependencies) slim.devDependencies = pkg.devDependencies;
      if (pkg.scripts) slim.scripts = pkg.scripts;
      sections.push(
        `### package.json (key fields)\n\`\`\`json\n${JSON.stringify(slim, null, 2)}\n\`\`\``
      );
    } catch {
      /* skip malformed package.json */
    }
  }

  // 2. Language config files
  for (const configFile of ['tsconfig.json', 'pyproject.toml', 'Cargo.toml']) {
    const cfgPath = path.join(workspaceRoot, configFile);
    if (fs.existsSync(cfgPath)) {
      try {
        const content = fs.readFileSync(cfgPath, 'utf-8').split('\n').slice(0, 30).join('\n');
        sections.push(`### ${configFile}\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        /* skip */
      }
    }
  }

  // .csproj files
  const csprojFiles = listFilesShallow(workspaceRoot).filter((f) => f.endsWith('.csproj'));
  for (const f of csprojFiles.slice(0, 2)) {
    try {
      const content = fs
        .readFileSync(path.join(workspaceRoot, f), 'utf-8')
        .split('\n')
        .slice(0, 30)
        .join('\n');
      sections.push(`### ${f}\n\`\`\`xml\n${content}\n\`\`\``);
    } catch {
      /* skip */
    }
  }

  // 3. Top-level directory listing (1 level deep)
  const dirListing = listDirTree(workspaceRoot, 1);
  if (dirListing) {
    sections.push(`### Directory structure\n\`\`\`\n${dirListing}\n\`\`\``);
  }

  // 4. First 50 lines of up to 3 source files matching spec topic
  const relevantFiles = findRelevantSourceFiles(workspaceRoot, specName, 3);
  for (const relPath of relevantFiles) {
    try {
      const content = fs
        .readFileSync(path.join(workspaceRoot, relPath), 'utf-8')
        .split('\n')
        .slice(0, 50)
        .join('\n');
      sections.push(`### ${relPath} (first 50 lines)\n\`\`\`\n${content}\n\`\`\``);
    } catch {
      /* skip */
    }
  }

  if (sections.length === 0) return '';

  return `---\n## Workspace Context\n\n${sections.join('\n\n')}`;
}

function listFilesShallow(dir: string): string[] {
  try {
    return (fs.readdirSync(dir, { withFileTypes: true }) as Dirent[])
      .filter((e: Dirent) => e.isFile())
      .map((e: Dirent) => e.name);
  } catch {
    return [];
  }
}

function listDirTree(root: string, maxDepth: number, prefix = '', depth = 0): string {
  if (depth > maxDepth) return '';
  let entries: Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }) as Dirent[];
  } catch {
    return '';
  }

  const lines: string[] = [];
  const filtered = entries
    .filter((e: Dirent) => !CONTEXT_SKIP.has(e.name) && !e.name.startsWith('.'))
    .sort((a: Dirent, b: Dirent) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  for (const e of filtered) {
    if (e.isDirectory()) {
      lines.push(`${prefix}${e.name}/`);
      if (depth < maxDepth) {
        const sub = listDirTree(path.join(root, e.name), maxDepth, prefix + '  ', depth + 1);
        if (sub) lines.push(sub);
      }
    } else {
      lines.push(`${prefix}${e.name}`);
    }
  }
  return lines.join('\n');
}

function findRelevantSourceFiles(root: string, specName: string, max: number): string[] {
  // Normalize spec name into keywords for fuzzy matching
  const keywords = specName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/);
  const sourceExts = new Set(['.ts', '.js', '.tsx', '.jsx', '.py', '.cs', '.java', '.go', '.rs']);
  const results: string[] = [];

  function walk(dir: string, relDir: string, depth: number) {
    if (depth > 4 || results.length >= max) return;
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= max) return;
      if (CONTEXT_SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(full, rel, depth + 1);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      if (!sourceExts.has(ext)) continue;
      const nameLower = e.name.toLowerCase();
      if (keywords.some((kw) => kw.length >= 3 && nameLower.includes(kw))) {
        results.push(rel);
      }
    }
  }

  walk(root, '', 0);
  return results;
}

// ── Steering scaffolding ──────────────────────────────────────────────────────

export function scaffoldSteering(specsRoot: string, workspaceRoot: string): string[] {
  const steeringDir = path.join(specsRoot, 'steering');
  fs.mkdirSync(steeringDir, { recursive: true });
  const written: string[] = [];

  // product.md — from README or package.json description
  const productContent = inferProduct(workspaceRoot);
  if (productContent) {
    fs.writeFileSync(path.join(steeringDir, 'product.md'), productContent, 'utf-8');
    written.push('steering/product.md');
  }

  // tech.md — from dependencies, tsconfig, build scripts
  const techContent = inferTech(workspaceRoot);
  if (techContent) {
    fs.writeFileSync(path.join(steeringDir, 'tech.md'), techContent, 'utf-8');
    written.push('steering/tech.md');
  }

  // structure.md — top-level directory listing with annotations
  const structureContent = inferStructure(workspaceRoot);
  if (structureContent) {
    fs.writeFileSync(path.join(steeringDir, 'structure.md'), structureContent, 'utf-8');
    written.push('steering/structure.md');
  }

  return written;
}

function inferProduct(workspaceRoot: string): string | null {
  const lines: string[] = ['# Product Context\n'];

  // Try README first
  for (const name of ['README.md', 'readme.md', 'Readme.md']) {
    const readmePath = path.join(workspaceRoot, name);
    if (fs.existsSync(readmePath)) {
      try {
        const content = fs.readFileSync(readmePath, 'utf-8');
        // Extract first paragraph or heading + description
        const firstSection = content.split('\n').slice(0, 20).join('\n').trim();
        if (firstSection) {
          lines.push(firstSection);
          break;
        }
      } catch {
        /* skip */
      }
    }
  }

  // Supplement with package.json description
  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.description) lines.push(`\n**Package description:** ${pkg.description}`);
      if (pkg.keywords) lines.push(`**Keywords:** ${pkg.keywords.join(', ')}`);
    } catch {
      /* skip */
    }
  }

  return lines.length > 1 ? lines.join('\n') : null;
}

function inferTech(workspaceRoot: string): string | null {
  const lines: string[] = ['# Technology Stack\n'];

  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = Object.keys(pkg.dependencies || {});
      const devDeps = Object.keys(pkg.devDependencies || {});
      if (deps.length > 0) lines.push(`**Dependencies:** ${deps.join(', ')}`);
      if (devDeps.length > 0) lines.push(`**Dev dependencies:** ${devDeps.join(', ')}`);
      if (pkg.scripts) {
        lines.push('\n**Build scripts:**');
        for (const [k, v] of Object.entries(pkg.scripts)) {
          lines.push(`- \`${k}\`: \`${v}\``);
        }
      }
      if (pkg.engines) lines.push(`\n**Engines:** ${JSON.stringify(pkg.engines)}`);
    } catch {
      /* skip */
    }
  }

  if (fs.existsSync(path.join(workspaceRoot, 'tsconfig.json'))) {
    lines.push('\n**Language:** TypeScript');
  }

  const pyprojectPath = path.join(workspaceRoot, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    lines.push('\n**Language:** Python');
    try {
      const content = fs.readFileSync(pyprojectPath, 'utf-8').split('\n').slice(0, 20).join('\n');
      lines.push(`\`\`\`toml\n${content}\n\`\`\``);
    } catch {
      /* skip */
    }
  }

  return lines.length > 1 ? lines.join('\n') : null;
}

function inferStructure(workspaceRoot: string): string | null {
  const tree = listDirTree(workspaceRoot, 1);
  if (!tree) return null;
  return `# Project Structure\n\n\`\`\`\n${tree}\n\`\`\`\n\nEdit this file to annotate what each directory contains and any conventions to follow.`;
}

// ── Test questionnaire ────────────────────────────────────────────────────────

export function writeTestQuestionnaire(
  specsRoot: string,
  specName: string,
  q: TestQuestionnaire
): void {
  const dir = path.join(specsRoot, specName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_test_questionnaire.json'), JSON.stringify(q, null, 2), 'utf-8');
}

export function readTestQuestionnaire(
  specsRoot: string,
  specName: string
): TestQuestionnaire | null {
  const p = path.join(specsRoot, specName, '_test_questionnaire.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

// ── Import command ────────────────────────────────────────────────────────────

export function importFile(
  specsRoot: string,
  specName: string,
  stage: Stage,
  filePath: string
): void {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const content = fs.readFileSync(filePath, 'utf-8');
  const dir = path.join(specsRoot, specName);
  fs.mkdirSync(dir, { recursive: true });
  writeConfig(dir);
  fs.writeFileSync(path.join(dir, STAGE_FILES[stage]), content, 'utf-8');
  if (stage === 'tasks') {
    syncProgressFromMarkdown(specsRoot, specName, content);
  }
}

// ── Cross-spec referencing ────────────────────────────────────────────────────

export function loadCrossSpecContext(specsRoot: string, contextSpecName: string): string | null {
  const req = readStage(specsRoot, contextSpecName, 'requirements');
  const des = readStage(specsRoot, contextSpecName, 'design');
  if (!req && !des) return null;

  const parts: string[] = [`---\n## Reference: ${contextSpecName}\n`];
  if (req) parts.push(`### Requirements\n${req}`);
  if (des) parts.push(`### Design\n${des}`);
  parts.push(
    '---\nConsider the above reference spec when generating. Ensure consistency with its design decisions and avoid duplicating functionality it already covers.'
  );
  return parts.join('\n\n');
}

// ── Hook definitions ─────────────────────────────────────────────────────────

export interface HookDefinition {
  name: string;
  trigger: 'onSave' | 'onCreate' | 'onDelete' | 'manual';
  glob: string;
  action: string;
}

export function loadHooks(specsRoot: string): HookDefinition[] {
  const hooksDir = path.join(specsRoot, 'hooks');
  if (!fs.existsSync(hooksDir)) return [];

  const hooks: HookDefinition[] = [];
  const files = (fs.readdirSync(hooksDir, { withFileTypes: true }) as Dirent[])
    .filter((f: Dirent) => f.isFile() && f.name.endsWith('.json'))
    .map((f: Dirent) => f.name)
    .sort();

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(hooksDir, file), 'utf-8');
      const hook = JSON.parse(content) as HookDefinition;
      if (hook.name && hook.trigger && hook.action) {
        hooks.push(hook);
      }
    } catch {
      /* skip malformed hook files */
    }
  }
  return hooks;
}

/**
 * Escape a string for safe use as a single argument in the host shell.
 * Reduces command-injection risk when paths or spec names contain metacharacters.
 * Windows: PowerShell-style (single-quote wrap; ' → '').
 * Unix: sh-style (single-quote wrap; ' → '\'').
 */
function escapeForShell(value: string): string {
  if (process.platform === 'win32') {
    return "'" + value.replace(/'/g, "''") + "'";
  }
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function resolveHookAction(action: string, vars: Record<string, string>): string {
  let resolved = action;
  for (const [key, value] of Object.entries(vars)) {
    const safe = escapeForShell(value);
    resolved = resolved.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), safe);
  }
  return resolved;
}

// ── Vibe context (transcript-aware generation) ────────────────────────────────

export function writeVibeContext(
  specsRoot: string,
  specName: string,
  vibeContext: VibeContext
): void {
  const configPath = path.join(specsRoot, specName, CONFIG_FILE);
  let config: SpecConfig;
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      config = { generationMode: 'requirements-first', version: '2.1' };
    }
  } else {
    config = { generationMode: 'requirements-first', version: '2.1' };
  }
  config.vibeContext = vibeContext;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function loadVibeContext(specsRoot: string, specName: string): VibeContext | null {
  const config = readConfig(specsRoot, specName);
  return config?.vibeContext ?? null;
}

export function writeTestFile(
  specsRoot: string,
  specName: string,
  filename: string,
  content: string
): void {
  const dir = path.join(specsRoot, specName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, 'utf-8');
}

export function readTestFile(specsRoot: string, specName: string, filename: string): string | null {
  const p = path.join(specsRoot, specName, filename);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}
