import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assembleSystemPrompt } from '../../core/promptAssembly';
import { buildSystemPrompt, DEFAULT_STEERING } from '../../core/prompts';
import { scaffoldCustomPrompts, writeSpecConfig } from '../../core/specStore';

describe('scaffoldCustomPrompts', () => {
  it('falls back to built-in default steering and lets explicit steering override it', () => {
    const defaultPrompt = buildSystemPrompt('design', { title: 'Default Steering' });
    expect(defaultPrompt).toContain(DEFAULT_STEERING);

    const customPrompt = buildSystemPrompt('design', {
      title: 'Custom Steering',
      steering: 'Keep flows deterministic.',
    });
    expect(customPrompt).toContain('Keep flows deterministic.');
    expect(customPrompt).not.toContain(DEFAULT_STEERING);
  });

  it('writes default prompt files that preserve built-in prompt behavior', () => {
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nspec-prompts-'));
    const specName = 'hello-world';
    const specDir = path.join(specsRoot, specName);
    fs.mkdirSync(specDir, { recursive: true });
    writeSpecConfig(specsRoot, specName, {
      generationMode: 'requirements-first',
      lightDesign: true,
      version: '0.5.0',
    });
    fs.writeFileSync(path.join(specDir, '_role.md'), 'You are a careful architect.\n', 'utf-8');
    fs.writeFileSync(path.join(specDir, '_steering.md'), 'Keep flows deterministic.\n', 'utf-8');

    scaffoldCustomPrompts(specsRoot, specName);

    for (const stage of ['requirements', 'design', 'tasks', 'verify'] as const) {
      const assembled = assembleSystemPrompt({
        specsRoot,
        specName,
        stage,
        title: 'Hello World',
      });
      const expected = buildSystemPrompt(stage, {
        title: 'Hello World',
        role: 'You are a careful architect.',
        steering: 'Keep flows deterministic.',
        lightDesign: stage === 'design' ? true : undefined,
        requirementsFormat: stage === 'requirements' ? 'given-when-then' : undefined,
      });

      expect(assembled.systemPrompt).toBe(expected);
    }

    expect(fs.existsSync(path.join(specDir, '_prompts', 'README.md'))).toBe(true);
  });

  it('uses the EARS requirements template when the spec config requests it', () => {
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nspec-prompts-ears-'));
    const specName = 'ears-spec';
    fs.mkdirSync(path.join(specsRoot, specName), { recursive: true });
    writeSpecConfig(specsRoot, specName, {
      generationMode: 'requirements-first',
      requirementsFormat: 'ears',
      version: '0.5.0',
    });

    scaffoldCustomPrompts(specsRoot, specName);

    const requirementsPromptPath = path.join(specsRoot, specName, '_prompts', 'requirements.md');
    const requirementsPrompt = fs.readFileSync(requirementsPromptPath, 'utf-8');
    expect(requirementsPrompt).toContain('produce a Requirements Document in Markdown using EARS');
    expect(requirementsPrompt).not.toContain('A User Story');

    const assembled = assembleSystemPrompt({
      specsRoot,
      specName,
      stage: 'requirements',
      title: 'EARS Spec',
    });
    const expected = buildSystemPrompt('requirements', {
      title: 'EARS Spec',
      requirementsFormat: 'ears',
    });

    expect(assembled.systemPrompt).toBe(expected);
  });
});
