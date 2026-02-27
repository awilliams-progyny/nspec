import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as store from './core/specStore';
import { getSpecsRoot, getWorkspaceRoot } from './workspace';

// Re-export types from core so existing consumers don't break.
export type {
  SpecInfo,
  TaskItem,
  TaskProgress,
  TestQuestionnaire,
  SpecConfig,
  SpecType,
  GenerationMode,
  TemplateName,
  TemplateInfo,
  HookDefinition,
  VibeContext,
  TaskCompletionResult,
} from './core/specStore';
export type { Stage } from './core/specStore';
export {
  ALL_STAGES,
  parseTaskItems,
  toFolderName,
  ALL_BUGFIX_STAGES,
  AVAILABLE_TEMPLATES,
  TEMPLATE_REGISTRY,
} from './core/specStore';

function requireSpecsRoot(): string {
  const root = getSpecsRoot();
  if (!root)
    throw new Error('No workspace folder open. Open a folder (File → Open Folder) to use nSpec.');
  return root;
}

// ── OpenSpec prompt loading (delegates to core with vscode-resolved roots) ───

export function loadCustomPrompt(specName: string, stage: store.Stage): string | null {
  const root = getSpecsRoot();
  if (!root) return null;
  // Try spec-level in configured specsRoot, then workspace-level .specs
  const result = store.loadCustomPrompt(root, specName, stage);
  if (result) return result;
  const wsRoot = getWorkspaceRoot();
  if (wsRoot) {
    const wsSpecsRoot = path.join(wsRoot, '.specs');
    if (wsSpecsRoot !== root) return store.loadCustomPrompt(wsSpecsRoot, specName, stage);
  }
  return null;
}

export function loadSteering(specName: string): string | null {
  const root = getSpecsRoot();
  if (!root) return null;
  return store.loadSteering(root, specName);
}

export function loadRole(specName: string): string | null {
  const root = getSpecsRoot();
  if (!root) return null;
  return store.loadRole(root, specName);
}

export function loadExtraSections(specName: string, stage: store.Stage): string[] {
  const root = getSpecsRoot();
  if (!root) return [];
  return store.loadExtraSections(root, specName, stage);
}

export function hasCustomPrompts(specName: string): boolean {
  const root = getSpecsRoot();
  if (!root) return false;
  return store.hasCustomPrompts(root, specName);
}

export function scaffoldCustomPrompts(specName: string): void {
  const root = getSpecsRoot();
  if (!root) return;
  store.scaffoldCustomPrompts(root, specName);
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function listSpecs(): store.SpecInfo[] {
  const root = getSpecsRoot();
  if (!root) return [];
  return store.listSpecs(root);
}

export function readStage(specName: string, stage: store.Stage): string | null {
  const root = getSpecsRoot();
  if (!root) return null;
  return store.readStage(root, specName, stage);
}

export function writeStage(specName: string, stage: store.Stage, content: string): void {
  const root = requireSpecsRoot();
  store.writeStage(root, specName, stage, content);
}

export function createSpecFolder(
  specName: string,
  mode?: store.GenerationMode,
  template?: string
): string {
  const root = requireSpecsRoot();
  return store.createSpecFolder(root, specName, mode, template);
}

export function deleteSpec(specName: string): void {
  const root = getSpecsRoot();
  if (!root) return;
  store.deleteSpec(root, specName);
}

export function renameSpec(oldName: string, newName: string): boolean {
  const root = getSpecsRoot();
  if (!root) return false;
  return store.renameSpec(root, oldName, newName);
}

export function openFileInEditor(specName: string, stage: store.Stage): void {
  const root = getSpecsRoot();
  if (!root) return;
  const filePath = path.join(root, specName, `${stage}.md`);
  if (fs.existsSync(filePath)) {
    vscode.window.showTextDocument(vscode.Uri.file(filePath));
  }
}

// ── Task progress ─────────────────────────────────────────────────────────────

export function readTaskProgress(specName: string): store.TaskProgress | null {
  const root = getSpecsRoot();
  if (!root) return null;
  return store.readTaskProgress(root, specName);
}

export function writeTaskProgress(specName: string, progress: store.TaskProgress): void {
  const root = getSpecsRoot();
  if (!root) return;
  store.writeTaskProgress(root, specName, progress);
}

export function syncProgressFromMarkdown(
  specName: string,
  tasksMarkdown: string
): store.TaskProgress {
  const root = requireSpecsRoot();
  return store.syncProgressFromMarkdown(root, specName, tasksMarkdown);
}

export function toggleTaskItem(specName: string, taskId: string): store.TaskProgress | null {
  const root = getSpecsRoot();
  if (!root) return null;
  return store.toggleTaskItem(root, specName, taskId);
}

// ── Workspace context & steering ──────────────────────────────────────────────

export function buildWorkspaceContext(specName: string): string {
  const wsRoot = getWorkspaceRoot();
  if (!wsRoot) return '';
  return store.buildWorkspaceContext(wsRoot, specName);
}

export function setupSteering(): string[] {
  const root = getSpecsRoot();
  const wsRoot = getWorkspaceRoot();
  if (!root || !wsRoot) return [];
  return store.scaffoldSteering(root, wsRoot);
}

// ── Test questionnaire ────────────────────────────────────────────────────────

export function writeTestQuestionnaire(specName: string, q: store.TestQuestionnaire): void {
  const root = getSpecsRoot();
  if (!root) return;
  store.writeTestQuestionnaire(root, specName, q);
}

export function readTestQuestionnaire(specName: string): store.TestQuestionnaire | null {
  const root = getSpecsRoot();
  if (!root) return null;
  return store.readTestQuestionnaire(root, specName);
}

export function writeTestFile(specName: string, filename: string, content: string): void {
  const root = getSpecsRoot();
  if (!root) return;
  store.writeTestFile(root, specName, filename, content);
}

export function readTestFile(specName: string, filename: string): string | null {
  const root = getSpecsRoot();
  if (!root) return null;
  return store.readTestFile(root, specName, filename);
}

// ── Bugfix stages ─────────────────────────────────────────────────────────────

export function readBugfixStage(specName: string, stage: string): string | null {
  const root = getSpecsRoot();
  if (!root) return null;
  return store.readBugfixStage(root, specName, stage);
}

export function writeBugfixStage(specName: string, stage: string, content: string): void {
  const root = requireSpecsRoot();
  store.writeBugfixStage(root, specName, stage, content);
}

// ── Config ────────────────────────────────────────────────────────────────────

export function readConfig(specName: string): store.SpecConfig | null {
  const root = getSpecsRoot();
  if (!root) return null;
  return store.readConfig(root, specName);
}

export function writeSpecConfig(specName: string, config: store.SpecConfig): void {
  const root = requireSpecsRoot();
  store.writeSpecConfig(root, specName, config);
}

// ── Templates ─────────────────────────────────────────────────────────────────

export function scaffoldTemplate(specName: string, templateId: string): void {
  const root = getSpecsRoot();
  if (!root) return;
  store.scaffoldTemplate(root, specName, templateId);
}

export function getTemplateInfo(templateId: string): store.TemplateInfo | null {
  return store.getTemplateInfo(templateId);
}

// ── Import ────────────────────────────────────────────────────────────────────

export function importFile(specName: string, stage: store.Stage, filePath: string): void {
  const root = requireSpecsRoot();
  store.importFile(root, specName, stage, filePath);
}

// ── Cross-spec referencing ────────────────────────────────────────────────────

export function loadCrossSpecContext(contextSpecName: string): string | null {
  const root = getSpecsRoot();
  if (!root) return null;
  return store.loadCrossSpecContext(root, contextSpecName);
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function loadHooks(): store.HookDefinition[] {
  const root = getSpecsRoot();
  if (!root) return [];
  return store.loadHooks(root);
}

export function resolveHookAction(action: string, vars: Record<string, string>): string {
  return store.resolveHookAction(action, vars);
}

// ── Vibe-to-spec ──────────────────────────────────────────────────────────────

export function writeVibeContext(specName: string, vibeContext: store.VibeContext): void {
  const root = requireSpecsRoot();
  store.writeVibeContext(root, specName, vibeContext);
}

export function loadVibeContext(specName: string): store.VibeContext | null {
  const root = getSpecsRoot();
  if (!root) return null;
  return store.loadVibeContext(root, specName);
}

// ── Task completion detection (M8) ────────────────────────────────────────

export function checkTaskCompletion(specName: string): store.TaskCompletionResult[] {
  const root = getSpecsRoot();
  const wsRoot = getWorkspaceRoot();
  if (!root || !wsRoot) return [];
  return store.checkTaskCompletion(wsRoot, root, specName);
}
