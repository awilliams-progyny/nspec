import { describe, expect, it } from 'vitest';
import { isDone, makeStepId, parseNspecMeta, upsertNspecMeta } from '../../core/nspecMeta';

describe('nspecMeta', () => {
  it('parses an existing nspec meta header', () => {
    const input = `<!-- nspec:
stage: requirements
step_id: req-123
done: false
-->

# Requirements`;
    const parsed = parseNspecMeta(input);
    expect(parsed.hasMeta).toBe(true);
    expect(parsed.meta.stage).toBe('requirements');
    expect(parsed.meta.step_id).toBe('req-123');
    expect(parsed.meta.done).toBe('false');
    expect(parsed.body.trimStart().startsWith('# Requirements')).toBe(true);
  });

  it('returns no meta for markdown without header', () => {
    const parsed = parseNspecMeta('# Hello');
    expect(parsed.hasMeta).toBe(false);
    expect(parsed.meta).toEqual({});
    expect(parsed.body).toBe('# Hello');
  });

  it('prepends meta when header is absent', () => {
    const out = upsertNspecMeta('# Body', {
      stage: 'design',
      step_id: 'design-1',
      done: 'false',
    });
    expect(out.startsWith('<!-- nspec:')).toBe(true);
    expect(out).toContain('stage: design');
    expect(out).toContain('step_id: design-1');
    expect(out).toContain('done: false');
    expect(out).toContain('\n\n# Body');
  });

  it('replaces existing meta while preserving body', () => {
    const input = `<!-- nspec:
stage: tasks
step_id: old-step
done: false
-->

- [ ] task`;
    const out = upsertNspecMeta(input, { step_id: 'new-step', done: 'true' });
    const parsed = parseNspecMeta(out);
    expect(parsed.meta.stage).toBe('tasks');
    expect(parsed.meta.step_id).toBe('new-step');
    expect(parsed.meta.done).toBe('true');
    expect(parsed.body.trim()).toBe('- [ ] task');
  });

  it('detects done state and keeps step id roundtrip', () => {
    const stepId = makeStepId('verify');
    const out = upsertNspecMeta('## Verify', {
      stage: 'verify',
      step_id: stepId,
      done: 'true',
    });
    const parsed = parseNspecMeta(out);
    expect(isDone(parsed.meta)).toBe(true);
    expect(parsed.meta.step_id).toBe(stepId);
  });
});
