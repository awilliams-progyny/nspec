import { describe, expect, it } from 'vitest';
import {
  buildSnapshotMarkdown,
  buildVerifyMarkdown,
  normalizeStageContent,
} from '../../core/verification';

function strongRequirements(): string {
  return [
    '# Requirements',
    '',
    '## Overview',
    'Define a concise spec workflow for a small feature.',
    '',
    '## Functional Requirements',
    '',
    '### FR-1',
    'As a developer, I want requirements written down so that scope is explicit.',
    '- GIVEN a new spec WHEN requirements are generated THEN it SHALL list the expected behavior clearly.',
    '',
    '### FR-2',
    'As a developer, I want testable acceptance criteria so that downstream stages stay aligned.',
    '- GIVEN a requirement WHEN it is reviewed THEN it SHALL be expressed with Given/When/Then wording.',
    '',
    '### FR-3',
    'As a developer, I want assumptions called out so that design decisions do not drift.',
    '- GIVEN open assumptions WHEN requirements are saved THEN the document SHALL include them explicitly.',
    '',
    '## Non-Functional Requirements',
    '- The workflow should stay readable and lightweight.',
    '',
    '## Constraints & Assumptions',
    '- Markdown files remain the source of truth.',
    '',
    '## Out of Scope',
    '- Historical verification revisions.',
  ].join('\n');
}

function strongDesign(): string {
  return [
    '# Design',
    '',
    '## Overview',
    'The design normalizes stage markdown and writes latest-only verification snapshots.',
    '',
    '## Architecture',
    '- `verification.ts` rebuilds canonical gap sections.',
    '- `specStore.ts` rewrites `_verify/*-gap.md` files.',
    '',
    '## Sequence Diagrams',
    '```mermaid',
    'sequenceDiagram',
    '  participant User',
    '  participant Store',
    '  User->>Store: writeStage()',
    '  Store-->>User: normalized stage + snapshots',
    '```',
    '',
    '## Component Breakdown',
    '- Stage normalization',
    '- Snapshot writing',
    '- Derived verify refresh',
    '',
    '## Data Models',
    '- `NormalizeStageResult` stores score, notes, additions, and Jira comment.',
    '',
    '## Technology Choices',
    '- TypeScript and markdown-backed files.',
  ].join('\n');
}

function strongTasks(): string {
  return [
    '# Implementation Plan',
    '',
    '## Phase 1 - Normalize Stages',
    '- [ ] Normalize requirements gap blocks (S) _Requirements: FR-1_',
    '- [ ] Normalize design gap blocks (S) _Requirements: FR-2_',
    '- [ ] Normalize tasks gap blocks (S) _Requirements: FR-3_',
    '',
    '## Phase 2 - Refresh Verification',
    '- [ ] Rewrite latest snapshot files (S) _Requirements: FR-1, FR-2_',
    '- [ ] Refresh verify.md after stage writes (M) _Requirements: FR-2, FR-3_',
  ].join('\n');
}

describe('normalizeStageContent', () => {
  it('inserts the canonical gap block in the correct place for requirements, design, and tasks', () => {
    const requirements = normalizeStageContent(
      'requirements',
      [
        '# Requirements',
        '',
        '## Overview',
        'Short overview.',
        '',
        '## Functional Requirements',
      ].join('\n')
    ).content;
    const design = normalizeStageContent(
      'design',
      ['# Design', '', '## Overview', 'Short overview.', '', '## Architecture', '- Core flow'].join(
        '\n'
      )
    ).content;
    const tasks = normalizeStageContent(
      'tasks',
      [
        '# Implementation Plan',
        '',
        '## Phase 1',
        '- [ ] Build feature (S) _Requirements: FR-1_',
      ].join('\n')
    ).content;

    expect(requirements.indexOf('## Gaps & Analysis')).toBeGreaterThan(
      requirements.indexOf('## Overview')
    );
    expect(requirements.indexOf('## Gaps & Analysis')).toBeLessThan(
      requirements.indexOf('## Functional Requirements')
    );

    expect(design.indexOf('## Gaps & Analysis')).toBeGreaterThan(design.indexOf('## Overview'));
    expect(design.indexOf('## Gaps & Analysis')).toBeLessThan(design.indexOf('## Architecture'));

    expect(tasks.indexOf('## Gaps & Analysis')).toBeLessThan(tasks.indexOf('## Phase 1'));
    expect(tasks).toContain('### Score');
    expect(tasks).toContain('### Gap Notes');
    expect(tasks).toContain('### Suggested Jira Comment');
  });

  it('allows strong stages to emit Gap Notes none and Suggested Jira Comment N/A', () => {
    for (const [stage, input] of [
      ['requirements', strongRequirements()],
      ['design', strongDesign()],
      ['tasks', strongTasks()],
    ] as const) {
      const normalized = normalizeStageContent(stage, input);

      expect(normalized.gapNotes).toEqual(['None']);
      expect(normalized.suggestedJiraComment).toBe('N/A');
      expect(normalized.content).toContain('### Gap Notes\n- None');
      expect(normalized.content).toContain('### Suggested Jira Comment\nN/A');
      expect(normalized.content).not.toContain('### Recommended Additions');
    }
  });

  it('preserves the codex-ui nspec meta header at the top when normalizing', () => {
    const input = [
      '<!-- nspec:',
      'stage: requirements',
      'step_id: req-123',
      'done: true',
      '-->',
      '',
      '# Requirements',
      '',
      '## Overview',
      'Short overview only.',
    ].join('\n');

    const normalized = normalizeStageContent('requirements', input).content;

    expect(normalized.startsWith('<!-- nspec:')).toBe(true);
    expect(normalized.indexOf('# Requirements')).toBeGreaterThan(0);
    expect(normalized.indexOf('## Gaps & Analysis')).toBeGreaterThan(
      normalized.indexOf('# Requirements')
    );
  });

  it('builds verify.md with the simplified section order', () => {
    const requirements = normalizeStageContent('requirements', strongRequirements());
    const design = normalizeStageContent('design', strongDesign());
    const tasks = normalizeStageContent('tasks', strongTasks());

    const verify = buildVerifyMarkdown({
      requirements: {
        stage: 'requirements',
        updatedAt: '2026-03-19T10:00:00.000Z',
        content: buildSnapshotMarkdown('requirements', requirements, '2026-03-19T10:00:00.000Z'),
        analysis: requirements,
      },
      design: {
        stage: 'design',
        updatedAt: '2026-03-19T10:01:00.000Z',
        content: buildSnapshotMarkdown('design', design, '2026-03-19T10:01:00.000Z'),
        analysis: design,
      },
      tasks: {
        stage: 'tasks',
        updatedAt: '2026-03-19T10:02:00.000Z',
        content: buildSnapshotMarkdown('tasks', tasks, '2026-03-19T10:02:00.000Z'),
        analysis: tasks,
      },
    });

    expect(verify.indexOf('## Verdict')).toBeLessThan(verify.indexOf('## Suggested Jira Comment'));
    expect(verify.indexOf('## Suggested Jira Comment')).toBeLessThan(
      verify.indexOf('## Recommended Additions')
    );
    expect(verify.indexOf('## Recommended Additions')).toBeLessThan(
      verify.indexOf('## Gap Report')
    );
    expect(verify.indexOf('## Gap Report')).toBeLessThan(
      verify.indexOf('## Verification Snapshots')
    );
  });
});
