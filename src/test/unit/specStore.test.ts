/** Minimal unit tests for specStore. Run: npm run test */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseTaskItems,
  toFolderName,
  resolveHookAction,
  readTaskProgress,
  setAllTaskSelections,
  setTaskItemSelection,
  syncProgressFromMarkdown,
  writeStage,
  readStage,
  refreshVerify,
} from '../../core/specStore';

describe('parseTaskItems', () => {
  it('parses checkboxes and strips effort markers', () => {
    const items = parseTaskItems('- [ ] First\n- [x] Done (M)\n');
    expect(items).toHaveLength(2);
    expect(items[0].label).toBe('First');
    expect(items[0].checked).toBe(false);
    expect(items[1].checked).toBe(true);
  });
  it('returns empty for no checkboxes', () => {
    expect(parseTaskItems('')).toEqual([]);
  });

  it('uses source line index in stable IDs', () => {
    const items = parseTaskItems('- [ ] First\n\n- [ ] Second\n');
    expect(items[0].id).toBe('first_0');
    expect(items[1].id).toBe('second_2');
  });
});

describe('task progress tri-state', () => {
  it('tracks done, checked, and skipped selections', () => {
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nspec-store-'));
    const specName = 'tri-state';
    const markdown = ['- [x] Done task', '- [ ] Build API', '- [ ] Wire UI'].join('\n');

    const items = parseTaskItems(markdown);
    const initial = syncProgressFromMarkdown(specsRoot, specName, markdown);
    expect(initial.done).toBe(1);
    expect(initial.checked).toBe(0);
    expect(initial.skipped).toBe(2);

    const selected = setTaskItemSelection(specsRoot, specName, items[1].id, 'checked');
    expect(selected?.done).toBe(1);
    expect(selected?.checked).toBe(1);
    expect(selected?.skipped).toBe(1);

    const bulk = setAllTaskSelections(specsRoot, specName, 'checked');
    expect(bulk?.done).toBe(1);
    expect(bulk?.checked).toBe(2);
    expect(bulk?.skipped).toBe(0);

    const persisted = readTaskProgress(specsRoot, specName);
    expect(persisted?.items[items[0].id]).toBe('done');
    expect(persisted?.items[items[1].id]).toBe('checked');
    expect(persisted?.items[items[2].id]).toBe('checked');
  });
});

describe('toFolderName', () => {
  it('normalizes to lowercase hyphenated', () => {
    expect(toFolderName('My Spec')).toBe('my-spec');
    expect(toFolderName('')).toBe('my-spec');
  });
});

describe('resolveHookAction', () => {
  it('substitutes and escapes vars', () => {
    const r = resolveHookAction('run ${x}', { x: 'a;b' });
    expect(r).toContain('a;b');
    expect(r).toMatch(/'/);
  });
});

function strongRequirements(): string {
  return [
    '# Requirements',
    '',
    '## Overview',
    'Support a small, repeatable markdown spec workflow for a single feature.',
    '',
    '## Functional Requirements',
    '',
    '### FR-1',
    'As a developer, I want spec files generated in a stable order so that the workflow stays predictable.',
    '- GIVEN a new feature description WHEN requirements are generated THEN the document SHALL define the required stage files.',
    '',
    '### FR-2',
    'As a developer, I want verify output derived from current stage docs so that I can trust the latest summary.',
    '- GIVEN requirements, design, and tasks exist WHEN verify is refreshed THEN the document SHALL summarize the current spec set.',
    '',
    '### FR-3',
    'As a developer, I want lightweight gap analysis in each stage so that missing details are visible without a sidecar state machine.',
    '- GIVEN a stage document WHEN nSpec saves it THEN the document SHALL contain a normalized Gaps & Analysis section.',
    '',
    '## Non-Functional Requirements',
    '- The workflow should stay concise and predictable for small features.',
    '',
    '## Constraints & Assumptions',
    '- Markdown files are the source of truth.',
    '',
    '## Out of Scope',
    '- Persisted verification revision history.',
  ].join('\n');
}

function strongDesign(): string {
  return [
    '# Design',
    '',
    '## Overview',
    'Verification snapshots are generated from normalized stage markdown and stored as latest-only files.',
    '',
    '## Architecture',
    '- `specStore.writeStage` normalizes requirements, design, and tasks documents.',
    '- `specStore.refreshVerify` rebuilds snapshots and verify.md from current stage files.',
    '',
    '## Sequence Diagrams',
    '```mermaid',
    'sequenceDiagram',
    '  participant User',
    '  participant Store',
    '  participant Verify',
    '  User->>Store: writeStage(tasks)',
    '  Store->>Verify: refreshVerify()',
    '  Verify-->>User: verify.md + snapshots',
    '```',
    '',
    '## Component Breakdown',
    '- `verification.ts` owns canonical gap-block normalization.',
    '- `specStore.ts` owns file writes and snapshot refresh.',
    '',
    '## Data Models',
    '- `NormalizeStageResult` carries score, gaps, additions, Jira comment, and normalized content.',
    '',
    '## Technology Choices',
    '- TypeScript with filesystem-backed markdown files.',
  ].join('\n');
}

function sparseDesign(): string {
  return [
    '# Design',
    '',
    '## Overview',
    'Only the high-level intent is written down.',
    '',
    '## Architecture',
    '- Keep the flow simple.',
  ].join('\n');
}

function strongTasks(): string {
  return [
    '# Implementation Plan',
    '',
    '## Phase 1 - Core',
    '- [ ] Normalize requirements gap blocks (S) _Requirements: FR-1_',
    '- [ ] Normalize design gap blocks (S) _Requirements: FR-1_',
    '- [ ] Normalize tasks gap blocks (S) _Requirements: FR-3_',
    '',
    '## Phase 2 - Verification',
    '- [ ] Overwrite latest requirements snapshot (S) _Requirements: FR-2_',
    '- [ ] Overwrite latest design snapshot (S) _Requirements: FR-2_',
    '- [ ] Overwrite latest tasks snapshot (S) _Requirements: FR-2_',
    '- [ ] Refresh verify.md after stage writes (M) _Requirements: FR-2, FR-3_',
  ].join('\n');
}

describe('verification snapshots and auto-refresh', () => {
  it('writes canonical Gaps & Analysis content to stage files', () => {
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nspec-gap-'));
    const specName = 'gap-spec';
    writeStage(
      specsRoot,
      specName,
      'requirements',
      ['# Requirements — Test', '', '## Overview', '- Basic overview only'].join('\n')
    );

    const stage = readStage(specsRoot, specName, 'requirements') || '';
    expect(stage).toContain('## Gaps & Analysis');
    expect(stage).toContain('### Score');
    expect(stage).toContain('### Gap Notes');
    expect(stage).toContain('### Suggested Jira Comment');
    expect(stage).not.toContain('### Key Gaps');
    expect(stage).not.toContain('### Suggested Remediation');
    expect(stage).not.toContain('### Paste-Ready Summary');
  });

  it('overwrites the latest-only stage snapshot file in _verify', () => {
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nspec-snapshot-'));
    const specName = 'snapshot-spec';
    const snapshotPath = path.join(specsRoot, specName, '_verify', 'requirements-gap.md');

    writeStage(
      specsRoot,
      specName,
      'requirements',
      ['# Requirements', '', '## Overview', 'Very rough requirements only.'].join('\n')
    );
    const first = fs.readFileSync(snapshotPath, 'utf-8');
    expect(first).toContain('#### Gap Notes');
    expect(first).not.toContain('#### Suggested Remediation');

    writeStage(specsRoot, specName, 'requirements', strongRequirements());
    const second = fs.readFileSync(snapshotPath, 'utf-8');

    expect(second).not.toBe(first);
    expect(second).toContain('### Requirements Snapshot');
    expect(second).toContain('#### Gap Notes');
    expect(second).toContain('- None');
    expect(second).toContain('#### Suggested Jira Comment');
    expect(second).toContain('N/A');
  });

  it('refreshes verify.md automatically after tasks are written and after later managed writes', () => {
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nspec-verify-auto-'));
    const specName = 'verify-auto';

    writeStage(specsRoot, specName, 'requirements', strongRequirements());
    writeStage(specsRoot, specName, 'design', strongDesign());
    const tasksResult = writeStage(specsRoot, specName, 'tasks', strongTasks());

    expect(tasksResult.verifyContent).toBeTruthy();
    const initialVerify = readStage(specsRoot, specName, 'verify') || '';
    expect(initialVerify).toContain('## Verification Snapshots');
    expect(initialVerify).toContain('### Requirements Snapshot');
    expect(initialVerify).toContain('### Design Snapshot');
    expect(initialVerify).toContain('### Tasks Snapshot');

    const designResult = writeStage(specsRoot, specName, 'design', sparseDesign());
    const refreshedVerify = designResult.verifyContent || '';

    expect(refreshedVerify).toContain('Design: Interaction flow is not visualized yet.');
    expect(readStage(specsRoot, specName, 'verify')).toBe(refreshedVerify);
  });

  it('rebuilds verification snapshots from current stage files on manual refresh', () => {
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nspec-verify-refresh-'));
    const specName = 'verify-refresh';
    const designPath = path.join(specsRoot, specName, 'design.md');
    const designSnapshotPath = path.join(specsRoot, specName, '_verify', 'design-gap.md');

    writeStage(specsRoot, specName, 'requirements', strongRequirements());
    writeStage(specsRoot, specName, 'design', strongDesign());
    writeStage(specsRoot, specName, 'tasks', strongTasks());

    const initialSnapshot = fs.readFileSync(designSnapshotPath, 'utf-8');
    fs.writeFileSync(designPath, sparseDesign(), 'utf-8');

    const verifyContent = refreshVerify(specsRoot, specName) || '';
    const refreshedSnapshot = fs.readFileSync(designSnapshotPath, 'utf-8');

    expect(refreshedSnapshot).not.toBe(initialSnapshot);
    expect(refreshedSnapshot).toContain('Interaction flow is not visualized yet.');
    expect(verifyContent).toContain('Design: Interaction flow is not visualized yet.');
  });
});
