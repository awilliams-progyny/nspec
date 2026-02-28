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
