import * as fs from 'fs';
import * as path from 'path';
import type { Stage, RequirementsFormat, SpecConfig, WorkspaceConfig } from './specStore';
import {
  loadCustomPrompt,
  loadRole,
  loadSteering,
  loadWorkspaceConfig,
  readConfig,
} from './specStore';
import { buildSystemPrompt, PromptContext } from './prompts';

export interface PromptAssemblyOptions {
  specsRoot: string;
  specName: string;
  stage: Stage;
  title?: string;
  fallbackSpecsRoot?: string;
  requirementsFormatOverride?: RequirementsFormat;
  lightDesignOverride?: boolean;
}

export interface PromptSourceMap {
  specsRoot: string;
  specName: string;
  stage: Stage;
  baseTemplate: Stage;
  workspaceConfigPath: string | null;
  specConfigPath: string | null;
  requirementsFormatSource: 'override' | 'spec-config' | 'workspace-config' | 'default';
  lightDesignSource: 'override' | 'spec-config' | 'default';
  steeringSources: string[];
  roleSource: string | null;
  promptOverrideSource: string | null;
  mechanisms: Array<'merge:steering' | 'replace:role' | 'replace:prompt'>;
}

export interface PromptAssemblyResult {
  systemPrompt: string;
  context: PromptContext;
  sourceMap: PromptSourceMap;
}

export function assembleSystemPrompt(options: PromptAssemblyOptions): PromptAssemblyResult {
  const {
    specsRoot,
    specName,
    stage,
    title,
    fallbackSpecsRoot,
    requirementsFormatOverride,
    lightDesignOverride,
  } = options;

  const specConfig = readConfig(specsRoot, specName);
  const wsConfig = loadWorkspaceConfig(specsRoot);

  const requirementsFormatSource = resolveRequirementsFormatSource(
    requirementsFormatOverride,
    specConfig,
    wsConfig
  );
  const requirementsFormat =
    requirementsFormatSource === 'override'
      ? requirementsFormatOverride
      : requirementsFormatSource === 'spec-config'
        ? specConfig?.requirementsFormat
        : requirementsFormatSource === 'workspace-config'
          ? wsConfig?.requirementsFormat
          : undefined;

  const lightDesignSource =
    typeof lightDesignOverride === 'boolean'
      ? 'override'
      : typeof specConfig?.lightDesign === 'boolean'
        ? 'spec-config'
        : 'default';
  const lightDesign =
    lightDesignSource === 'override'
      ? lightDesignOverride
      : lightDesignSource === 'spec-config'
        ? specConfig?.lightDesign
        : undefined;

  const resolvedTitle = title ?? specName;
  const role = loadRole(specsRoot, specName) ?? undefined;
  const steering = loadSteering(specsRoot, specName) ?? undefined;

  const context: PromptContext = {
    title: resolvedTitle,
    role,
    steering,
    lightDesign: stage === 'design' ? lightDesign : undefined,
    requirementsFormat: stage === 'requirements' ? requirementsFormat : undefined,
  };

  const promptOverride = resolveCustomPrompt(specsRoot, specName, stage, fallbackSpecsRoot);
  const systemPrompt = promptOverride.content
    ? promptOverride.content.replace(/{title}/g, resolvedTitle)
    : buildSystemPrompt(stage, context);

  const steeringSources = findSteeringSources(specsRoot, specName);
  const roleSource = findRoleSource(specsRoot, specName);
  const sourceMap: PromptSourceMap = {
    specsRoot,
    specName,
    stage,
    baseTemplate: stage,
    workspaceConfigPath: fileIfExists(path.join(specsRoot, 'config.json')),
    specConfigPath: fileIfExists(path.join(specsRoot, specName, 'spec.config.json')),
    requirementsFormatSource,
    lightDesignSource,
    steeringSources,
    roleSource,
    promptOverrideSource: promptOverride.source,
    mechanisms: buildMechanisms({
      steeringSources,
      roleSource,
      promptOverrideSource: promptOverride.source,
    }),
  };

  return { systemPrompt, context, sourceMap };
}

function resolveRequirementsFormatSource(
  override: RequirementsFormat | undefined,
  specConfig: SpecConfig | null,
  workspaceConfig: WorkspaceConfig | null
): PromptSourceMap['requirementsFormatSource'] {
  if (override) return 'override';
  if (specConfig?.requirementsFormat) return 'spec-config';
  if (workspaceConfig?.requirementsFormat) return 'workspace-config';
  return 'default';
}

function resolveCustomPrompt(
  specsRoot: string,
  specName: string,
  stage: Stage,
  fallbackSpecsRoot?: string
): { content: string | null; source: string | null } {
  const primary = resolveCustomPromptAtRoot(specsRoot, specName, stage);
  if (primary.content) return primary;

  if (fallbackSpecsRoot && fallbackSpecsRoot !== specsRoot) {
    return resolveCustomPromptAtRoot(fallbackSpecsRoot, specName, stage);
  }

  return { content: null, source: null };
}

function resolveCustomPromptAtRoot(
  specsRoot: string,
  specName: string,
  stage: Stage
): { content: string | null; source: string | null } {
  const specPromptPath = path.join(specsRoot, specName, '_prompts', `${stage}.md`);
  if (fs.existsSync(specPromptPath)) {
    return { content: loadCustomPrompt(specsRoot, specName, stage), source: specPromptPath };
  }

  const wsPromptPath = path.join(specsRoot, '_prompts', `${stage}.md`);
  if (fs.existsSync(wsPromptPath)) {
    return { content: loadCustomPrompt(specsRoot, specName, stage), source: wsPromptPath };
  }

  return { content: null, source: null };
}

function findSteeringSources(specsRoot: string, specName: string): string[] {
  const sources: string[] = [];

  const steeringDir = path.join(specsRoot, 'steering');
  if (fs.existsSync(steeringDir)) {
    const entries = fs.readdirSync(steeringDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => path.join(steeringDir, e.name))
      .sort();
    sources.push(...files);
  }

  const wsSteering = path.join(specsRoot, '_steering.md');
  if (fs.existsSync(wsSteering)) sources.push(wsSteering);

  const specSteering = path.join(specsRoot, specName, '_steering.md');
  if (fs.existsSync(specSteering)) sources.push(specSteering);

  return sources;
}

function findRoleSource(specsRoot: string, specName: string): string | null {
  const specRole = path.join(specsRoot, specName, '_role.md');
  if (fs.existsSync(specRole)) return specRole;
  const wsRole = path.join(specsRoot, '_role.md');
  if (fs.existsSync(wsRole)) return wsRole;
  return null;
}

function buildMechanisms(input: {
  steeringSources: string[];
  roleSource: string | null;
  promptOverrideSource: string | null;
}): PromptSourceMap['mechanisms'] {
  const mechanisms: PromptSourceMap['mechanisms'] = [];
  if (input.steeringSources.length > 0) mechanisms.push('merge:steering');
  if (input.roleSource) mechanisms.push('replace:role');
  if (input.promptOverrideSource) mechanisms.push('replace:prompt');
  return mechanisms;
}

function fileIfExists(filePath: string): string | null {
  return fs.existsSync(filePath) ? filePath : null;
}
