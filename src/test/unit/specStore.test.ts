/** Minimal unit tests for specStore. Run: npm run test */
import { describe, it, expect } from 'vitest';
import { parseTaskItems, toFolderName, resolveHookAction } from '../../core/specStore';

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
