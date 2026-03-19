export type StandardStage = 'requirements' | 'design' | 'tasks';

export interface StageAnalysis {
  score: number;
  gapNotes: string[];
  recommendedAdditions: string[];
  suggestedJiraComment: string;
  block: string;
}

export interface NormalizeStageResult extends StageAnalysis {
  content: string;
}

export interface SnapshotInfo {
  stage: StandardStage;
  updatedAt: string;
  content: string;
}

const GAP_SECTION_RE = /^##\s+Gaps\s*&\s*Analysis\s*$/im;
const SCORE_RE = /(\d{1,3})(?:\s*\/\s*(100|10))?/;
const NSPEC_META_RE = /^(<!--\s*nspec:[\s\S]*?-->)(?:\r?\n)*/i;
const LOW_VALUE_GAP_PATTERNS = [
  /remaining work is mostly/i,
  /proceed to/i,
  /minor tightening/i,
  /^none$/i,
];

function normalizeScore(raw: unknown): number {
  if (typeof raw !== 'number' || Number.isNaN(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function normalizeParsedScore(rawScore: string, rawDenominator?: string | null): number {
  const score = Number.parseInt(rawScore, 10);
  if (!rawDenominator) return normalizeScore(score);
  const denominator = Number.parseInt(rawDenominator, 10);
  if (!Number.isFinite(score) || !Number.isFinite(denominator) || denominator <= 0) {
    return normalizeScore(score);
  }
  return normalizeScore((score / denominator) * 100);
}

function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

function hasHeading(text: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^##\\s+${escaped}\\s*$`, 'im').test(text);
}

function splitGapSection(content: string): {
  before: string;
  section: string | null;
  after: string;
} {
  const match = GAP_SECTION_RE.exec(content);
  if (!match || match.index < 0) return { before: content.trimEnd(), section: null, after: '' };

  const start = match.index;
  const nextHeadingRe = /^##\s+/gm;
  nextHeadingRe.lastIndex = start + match[0].length;
  let nextIdx = content.length;
  for (;;) {
    const candidate = nextHeadingRe.exec(content);
    if (!candidate) break;
    if (candidate.index > start) {
      nextIdx = candidate.index;
      break;
    }
  }

  return {
    before: content.slice(0, start).trimEnd(),
    section: content.slice(start, nextIdx).trim(),
    after: content.slice(nextIdx).trimStart(),
  };
}

function splitLeadingMeta(content: string): { meta: string; body: string } {
  const match = NSPEC_META_RE.exec(content);
  if (!match || match.index !== 0) {
    return { meta: '', body: content };
  }
  return {
    meta: match[1].trim(),
    body: content.slice(match[0].length).trimStart(),
  };
}

function collectSubsectionBody(section: string, heading: string): string {
  if (!section.trim()) return '';
  const lines = section.split('\n');
  const headingRe = new RegExp(
    `^###\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
    'i'
  );
  const startIndex = lines.findIndex((line) => headingRe.test(line.trim()));
  if (startIndex < 0) return '';

  const body: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^###\s+/i.test(trimmed) || /^##\s+/i.test(trimmed)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

function collectBullets(section: string, heading: string): string[] {
  const body = collectSubsectionBody(section, heading);
  if (!body) return [];
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || line.startsWith('* '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}

function collectPlainText(section: string, heading: string): string {
  const body = collectSubsectionBody(section, heading);
  return body
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function parseSectionScore(section: string): number | null {
  const body = collectSubsectionBody(section, 'Score');
  if (!body) return null;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const numeric = SCORE_RE.exec(line);
    if (numeric) return normalizeParsedScore(numeric[1], numeric[2] ?? null);
  }
  return null;
}

function meaningfulGapNotes(notes: string[]): string[] {
  return notes.filter(
    (note) =>
      note.trim().length > 0 && !LOW_VALUE_GAP_PATTERNS.some((pattern) => pattern.test(note))
  );
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter((item) => item.length > 0))];
}

function buildStageJiraComment(
  stage: StandardStage,
  score: number,
  gapNotes: string[],
  recommendedAdditions: string[]
): string {
  const issues = meaningfulGapNotes(gapNotes);
  if (issues.length === 0 && score >= 85) return 'N/A';

  const stageLabel =
    stage === 'tasks' ? 'Task planning' : stage === 'design' ? 'Design' : 'Requirements';
  const issueText = issues.slice(0, 2).join('; ');
  const nextStep = recommendedAdditions[0];
  if (nextStep) {
    return `${stageLabel} is not implementation-ready yet (${score}/100). Main gaps: ${issueText}. Next step: ${nextStep}`;
  }
  return `${stageLabel} still has meaningful gaps (${score}/100): ${issueText}.`;
}

function analyzeRequirements(text: string): Omit<StageAnalysis, 'block'> {
  let score = text.trim() ? 35 : 0;
  const frCount = countMatches(text, /\bFR-\d+\b/g);
  const gwtCount = countMatches(text, /\bGIVEN\b|\bWHEN\b|\bTHEN\b/g);
  const earsCount = countMatches(text, /\bTHE SYSTEM SHALL\b/g);
  const hasOverview = hasHeading(text, 'Overview');
  const hasNfr = hasHeading(text, 'Non-Functional Requirements');
  const hasConstraints = hasHeading(text, 'Constraints & Assumptions');
  const hasOutOfScope = hasHeading(text, 'Out of Scope');

  if (hasOverview) score += 10;
  if (frCount >= 1) score += 18;
  if (frCount >= 3) score += 10;
  if (gwtCount >= 3 || earsCount >= 2) score += 18;
  if (hasNfr) score += 8;
  if (hasConstraints) score += 8;
  if (hasOutOfScope) score += 4;

  const gapNotes: string[] = [];
  const recommendedAdditions: string[] = [];

  if (frCount === 0) {
    gapNotes.push('Functional requirements are not clearly enumerated yet.');
    recommendedAdditions.push(
      'Add numbered functional requirements so expected behavior is explicit.'
    );
  }
  if (gwtCount < 3 && earsCount < 2) {
    gapNotes.push('Acceptance criteria are not consistently testable yet.');
    recommendedAdditions.push(
      'Rewrite core requirements with Given/When/Then or EARS statements so they can be verified directly.'
    );
  }
  if (!hasNfr) {
    gapNotes.push('Non-functional expectations are still implicit.');
    recommendedAdditions.push(
      'Add a short non-functional section covering performance, UX, or reliability as needed.'
    );
  }
  if (!hasConstraints) {
    gapNotes.push('Constraints and assumptions are not called out explicitly.');
    recommendedAdditions.push(
      'Add a constraints and assumptions section so downstream design stays aligned.'
    );
  }

  score = normalizeScore(score);
  const normalizedGapNotes = gapNotes.length > 0 ? gapNotes : ['None'];
  return {
    score,
    gapNotes: normalizedGapNotes,
    recommendedAdditions,
    suggestedJiraComment: buildStageJiraComment(
      'requirements',
      score,
      normalizedGapNotes,
      recommendedAdditions
    ),
  };
}

function analyzeDesign(text: string): Omit<StageAnalysis, 'block'> {
  let score = text.trim() ? 35 : 0;
  const hasOverview = hasHeading(text, 'Overview');
  const hasArchitecture = hasHeading(text, 'Architecture');
  const hasSequence = /```mermaid/i.test(text) || hasHeading(text, 'Sequence Diagrams');
  const hasComponents = hasHeading(text, 'Component Breakdown');
  const hasDataModels = hasHeading(text, 'Data Models');
  const hasTechChoices = hasHeading(text, 'Technology Choices');

  if (hasOverview) score += 8;
  if (hasArchitecture) score += 18;
  if (hasSequence) score += 12;
  if (hasComponents) score += 12;
  if (hasDataModels) score += 10;
  if (hasTechChoices) score += 8;

  const gapNotes: string[] = [];
  const recommendedAdditions: string[] = [];

  if (!hasArchitecture) {
    gapNotes.push('The main architecture flow is not described explicitly.');
    recommendedAdditions.push(
      'Add a short architecture section that explains the core flow and major boundaries.'
    );
  }
  if (!hasSequence) {
    gapNotes.push('Interaction flow is not visualized yet.');
    recommendedAdditions.push(
      'Add one Mermaid sequence diagram or an equivalent step-by-step flow for the primary path.'
    );
  }
  if (!hasComponents) {
    gapNotes.push('Component responsibilities are still implicit.');
    recommendedAdditions.push('List the main components and what each one owns.');
  }
  if (!hasDataModels) {
    gapNotes.push('Data shape expectations are not explicit.');
    recommendedAdditions.push(
      'Add the key data structures, payloads, or state transitions that implementation depends on.'
    );
  }

  score = normalizeScore(score);
  const normalizedGapNotes = gapNotes.length > 0 ? gapNotes : ['None'];
  return {
    score,
    gapNotes: normalizedGapNotes,
    recommendedAdditions,
    suggestedJiraComment: buildStageJiraComment(
      'design',
      score,
      normalizedGapNotes,
      recommendedAdditions
    ),
  };
}

function analyzeTasks(text: string): Omit<StageAnalysis, 'block'> {
  let score = text.trim() ? 35 : 0;
  const taskCount = countMatches(text, /^\s*-\s+\[[ xX]\]\s+/gm);
  const reqMapCount = countMatches(text, /_Requirements:\s*[^_]+_/g);
  const phaseCount = countMatches(text, /^##\s+/gm);

  if (taskCount >= 1) score += 15;
  if (taskCount >= 5) score += 10;
  if (taskCount >= 10) score += 5;
  if (reqMapCount >= 1) score += 15;
  if (reqMapCount >= Math.max(1, Math.floor(taskCount * 0.6))) score += 10;
  if (phaseCount >= 2) score += 10;

  const gapNotes: string[] = [];
  const recommendedAdditions: string[] = [];

  if (taskCount === 0) {
    gapNotes.push('Implementation tasks are not broken down into executable steps yet.');
    recommendedAdditions.push(
      'Add checkbox tasks that describe concrete build steps and testable outcomes.'
    );
  }
  if (reqMapCount < Math.max(1, Math.floor(taskCount * 0.5))) {
    gapNotes.push('Requirement traceability is incomplete across the task list.');
    recommendedAdditions.push('Add `_Requirements: FR-N_` mappings so coverage stays visible.');
  }
  if (phaseCount < 2 && taskCount > 0) {
    gapNotes.push('Tasks are not grouped into clear implementation phases.');
    recommendedAdditions.push(
      'Group tasks into a few logical phases so dependency order is easier to follow.'
    );
  }

  score = normalizeScore(score);
  const normalizedGapNotes = gapNotes.length > 0 ? gapNotes : ['None'];
  return {
    score,
    gapNotes: normalizedGapNotes,
    recommendedAdditions,
    suggestedJiraComment: buildStageJiraComment(
      'tasks',
      score,
      normalizedGapNotes,
      recommendedAdditions
    ),
  };
}

function analyzeStage(stage: StandardStage, text: string): Omit<StageAnalysis, 'block'> {
  if (stage === 'requirements') return analyzeRequirements(text);
  if (stage === 'design') return analyzeDesign(text);
  return analyzeTasks(text);
}

function buildCanonicalBlock(
  score: number,
  gapNotes: string[],
  recommendedAdditions: string[],
  suggestedJiraComment: string
): string {
  const lines = [
    '## Gaps & Analysis',
    '',
    '### Score',
    `- ${score}/100`,
    '',
    '### Gap Notes',
    ...(gapNotes.length > 0 ? gapNotes : ['None']).map((note) => `- ${note}`),
  ];

  if (recommendedAdditions.length > 0) {
    lines.push('', '### Recommended Additions', ...recommendedAdditions.map((item) => `- ${item}`));
  }

  lines.push('', '### Suggested Jira Comment', suggestedJiraComment || 'N/A');
  return lines.join('\n');
}

function insertAfterOverview(body: string, block: string): string {
  const overviewMatch = /^##\s+Overview\s*$/im.exec(body);
  if (!overviewMatch || overviewMatch.index < 0) {
    const lines = body.split('\n');
    if (lines[0]?.startsWith('#')) {
      return [lines[0], '', block, '', ...lines.slice(1)].join('\n').trim();
    }
    return [block, '', body]
      .filter((part) => part.trim().length > 0)
      .join('\n\n')
      .trim();
  }

  const start = overviewMatch.index;
  const nextHeadingRe = /^##\s+/gm;
  nextHeadingRe.lastIndex = start + overviewMatch[0].length;
  let insertIdx = body.length;
  for (;;) {
    const candidate = nextHeadingRe.exec(body);
    if (!candidate) break;
    if (candidate.index > start) {
      insertIdx = candidate.index;
      break;
    }
  }

  const before = body.slice(0, insertIdx).trimEnd();
  const after = body.slice(insertIdx).trimStart();
  return [before, block, after]
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
    .trim();
}

function insertAtTop(body: string, block: string): string {
  const lines = body.split('\n');
  if (lines[0]?.startsWith('#')) {
    return [lines[0], '', block, '', ...lines.slice(1)].join('\n').trim();
  }
  return [block, '', body]
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
    .trim();
}

export function normalizeStageContent(stage: StandardStage, content: string): NormalizeStageResult {
  const source = (content || '').trim();
  const { meta, body: sourceBody } = splitLeadingMeta(source);
  const split = splitGapSection(sourceBody);
  const body = [split.before, split.after].filter((part) => part.trim().length > 0).join('\n\n');
  const heuristic = analyzeStage(stage, body);
  const section = split.section || '';

  const score = parseSectionScore(section) ?? heuristic.score;
  const providedGapNotes = collectBullets(section, 'Gap Notes');
  const providedRecommended = collectBullets(section, 'Recommended Additions');
  const providedJiraComment = collectPlainText(section, 'Suggested Jira Comment');

  const gapNotes = unique(providedGapNotes.length > 0 ? providedGapNotes : heuristic.gapNotes);
  const recommendedAdditions = unique(
    providedRecommended.length > 0 ? providedRecommended : heuristic.recommendedAdditions
  );
  const suggestedJiraComment =
    providedJiraComment ||
    buildStageJiraComment(
      stage,
      score,
      gapNotes.length > 0 ? gapNotes : ['None'],
      recommendedAdditions
    );

  const canonicalBlock = buildCanonicalBlock(
    score,
    gapNotes.length > 0 ? gapNotes : ['None'],
    recommendedAdditions,
    suggestedJiraComment
  );

  const normalizedBody =
    stage === 'tasks'
      ? insertAtTop(body, canonicalBlock)
      : insertAfterOverview(body, canonicalBlock);
  const normalizedContent = [meta, normalizedBody.trim()]
    .filter((part) => part.trim().length > 0)
    .join('\n\n');

  return {
    score,
    gapNotes: gapNotes.length > 0 ? gapNotes : ['None'],
    recommendedAdditions,
    suggestedJiraComment,
    block: canonicalBlock,
    content: normalizedContent + '\n',
  };
}

function formatSnapshotHeading(stage: StandardStage): string {
  if (stage === 'tasks') return 'Tasks Snapshot';
  return `${stage.charAt(0).toUpperCase()}${stage.slice(1)} Snapshot`;
}

export function buildSnapshotMarkdown(
  stage: StandardStage,
  analysis: StageAnalysis,
  updatedAt: string
): string {
  const lines = [
    `### ${formatSnapshotHeading(stage)}`,
    `Updated: ${updatedAt}`,
    `Source: ${stage}.md`,
    '',
    '#### Score',
    `- ${analysis.score}/100`,
    '',
    '#### Gap Notes',
    ...(analysis.gapNotes.length > 0 ? analysis.gapNotes : ['None']).map((note) => `- ${note}`),
  ];

  if (analysis.recommendedAdditions.length > 0) {
    lines.push(
      '',
      '#### Recommended Additions',
      ...analysis.recommendedAdditions.map((item) => `- ${item}`)
    );
  }

  lines.push('', '#### Suggested Jira Comment', analysis.suggestedJiraComment || 'N/A');
  return lines.join('\n').trim() + '\n';
}

function summarizeOverallJiraComment(
  overallScore: number,
  gapReport: string[],
  recommendedAdditions: string[]
): string {
  if (gapReport.length === 0 && overallScore >= 90) return 'N/A';
  const issueText = gapReport.slice(0, 3).join(' ');
  const nextStep = recommendedAdditions[0];
  if (nextStep) {
    return `Spec review is not clean yet (${overallScore}/100). ${issueText} Recommended next step: ${nextStep}`;
  }
  return `Spec review has meaningful gaps (${overallScore}/100). ${issueText}`;
}

export function buildVerifyMarkdown(input: {
  requirements: SnapshotInfo & { analysis: StageAnalysis };
  design: SnapshotInfo & { analysis: StageAnalysis };
  tasks: SnapshotInfo & { analysis: StageAnalysis };
}): string {
  const analyses = [input.requirements.analysis, input.design.analysis, input.tasks.analysis];
  const overallScore =
    analyses.reduce((sum, entry) => sum + normalizeScore(entry.score), 0) / analyses.length;
  const roundedScore = normalizeScore(overallScore);

  const gapReport = unique([
    ...meaningfulGapNotes(input.requirements.analysis.gapNotes).map(
      (item) => `Requirements: ${item}`
    ),
    ...meaningfulGapNotes(input.design.analysis.gapNotes).map((item) => `Design: ${item}`),
    ...meaningfulGapNotes(input.tasks.analysis.gapNotes).map((item) => `Tasks: ${item}`),
  ]);

  const recommendedAdditions = unique([
    ...input.requirements.analysis.recommendedAdditions,
    ...input.design.analysis.recommendedAdditions,
    ...input.tasks.analysis.recommendedAdditions,
  ]);

  const verdict =
    gapReport.length === 0 && roundedScore >= 85
      ? 'The spec suite is coherent and ready for implementation. Only minor tightening is optional.'
      : roundedScore >= 70
        ? 'The spec suite is usable, but the listed gaps should be tightened before coding to avoid drift.'
        : 'The spec suite is not ready for implementation yet. Address the listed gaps before execution starts.';

  const suggestedJiraComment = summarizeOverallJiraComment(
    roundedScore,
    gapReport,
    recommendedAdditions
  );

  const lines = [
    '# Verification',
    '',
    '## Verdict',
    `Spec Health Score: ${roundedScore}/100`,
    '',
    verdict,
    '',
    '## Suggested Jira Comment',
    suggestedJiraComment,
    '',
    '## Recommended Additions',
    ...(recommendedAdditions.length > 0
      ? recommendedAdditions.map((item) => `- ${item}`)
      : ['- None']),
    '',
    '## Gap Report',
    ...(gapReport.length > 0 ? gapReport.map((item) => `- ${item}`) : ['- None']),
    '',
    '## Verification Snapshots',
    '',
    input.requirements.content.trim(),
    '',
    input.design.content.trim(),
    '',
    input.tasks.content.trim(),
  ];

  return lines.join('\n').trim() + '\n';
}

export function parseScoreFromMarkdown(content: string): number | null {
  const match =
    /(?:Spec Health Score|Score)\s*:?[\s-]*([0-9]{1,3})(?:\s*\/\s*(100|10))?/i.exec(content) ||
    /###\s+Score[\s\S]*?-\s*([0-9]{1,3})(?:\s*\/\s*(100|10))?/i.exec(content);
  if (!match) return null;
  return normalizeParsedScore(match[1], match[2] ?? null);
}

export function extractSuggestedJiraComment(content: string): string {
  const levelThree = collectPlainText(content, 'Suggested Jira Comment');
  if (levelThree) return levelThree;

  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) =>
    /^##\s+Suggested Jira Comment\s*$/i.test(line.trim())
  );
  if (startIndex < 0) return '';
  const body: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/i.test(line.trim())) break;
    body.push(line);
  }
  return body.join('\n').trim();
}
