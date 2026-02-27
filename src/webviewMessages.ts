/**
 * Typed message contracts between the extension host and the webview.
 *
 * ToExtensionMessage  — messages the webview sends to the extension host
 * FromExtensionMessage — messages the extension host sends to the webview
 *
 * Both directions use discriminated unions so TypeScript narrows the payload
 * automatically in every switch/case handler.
 */

import type { Stage, TaskProgress } from './core/specStore';
import type { AvailableModel } from './lmClient';

// ── Shared payload shapes ──────────────────────────────────────────────────────

export interface SpecSummary {
  name: string;
  hasRequirements: boolean;
  hasDesign: boolean;
  hasTasks: boolean;
  hasVerify: boolean;
  progress: TaskProgress | null;
}

export type TaskCheckStatus = 'complete' | 'partial' | 'incomplete';

export interface TaskCheckEntry {
  taskLabel: string;
  status: TaskCheckStatus;
  evidence: string[];
  score: number;
}

// ── Webview → Extension ────────────────────────────────────────────────────────

export type ToExtensionMessage =
  | { command: 'ready' }
  | { command: 'createSpec'; specName: string; prompt: string; specType: string; template: string; jiraUrl?: string }
  | { command: 'openSpec'; specName: string }
  | { command: 'generateDesign' }
  | { command: 'generateTasks' }
  | { command: 'refine'; stage: Stage; feedback: string }
  | { command: 'saveContent'; stage: Stage; content: string }
  | { command: 'setStage'; stage: Stage }
  | { command: 'runAllTasks' }
  | { command: 'openInEditor'; stage: Stage }
  | { command: 'deleteSpec'; specName: string }
  | { command: 'selectModel'; modelId: string }
  | { command: 'pickModelFromPalette' }
  | { command: 'generateVerify' }
  | { command: 'toggleTask'; taskId: string }
  | { command: 'scaffoldPrompts' }
  | { command: 'cancelGeneration' }
  | { command: 'getModels' }
  | { command: 'openSettings' }
  | { command: 'renameSpec'; oldName: string; newName: string }
  | { command: 'cascadeFromStage'; fromStage: string }
  | { command: 'generateRequirements' }
  | { command: 'runTask'; taskLabel: string }
  | { command: 'runAllTasksSupervised' }
  | { command: 'checkTask'; taskLabel: string }
  | { command: 'checkAllTasks' }
  | { command: 'importFromFile' }
  | { command: 'setRequirementsFormat'; format: 'given-when-then' | 'ears' }
  | { command: 'cancelTaskRun' }
  | { command: 'startClarification'; specName: string; description: string; specType: string; template: string; jiraUrl?: string }
  | { command: 'submitClarification'; specName: string; description: string; specType: string; qaTranscript: string; template: string; jiraUrl?: string };

// ── Extension → Webview ────────────────────────────────────────────────────────

export type FromExtensionMessage =
  | { type: 'init'; specs: SpecSummary[]; models: AvailableModel[]; selectedModelId: string | null; activeSpec: string | null; activeStage: Stage; contents: Partial<Record<Stage, string>>; requirementsFormat?: string }
  | { type: 'triggerNewSpec' }
  | { type: 'specCreated'; specName: string; displayName: string; stage: Stage; progress: TaskProgress | null; hasCustomPrompts: boolean; vibeSource?: boolean }
  | { type: 'specOpened'; specName: string; activeStage: Stage; contents: Partial<Record<Stage, string>>; progress: TaskProgress | null; hasCustomPrompts: boolean; requirementsFormat?: string }
  | { type: 'specDeleted'; specName: string }
  | { type: 'specRenamed'; oldName: string; newName: string }
  | { type: 'streamStart'; stage: Stage; isRefine?: boolean }
  | { type: 'streamChunk'; stage: Stage; chunk: string }
  | { type: 'streamDone'; stage: Stage; content: string }
  | { type: 'usingCustomPrompt'; stage: Stage }
  | { type: 'error'; message: string }
  | { type: 'saved'; stage: Stage }
  | { type: 'progressUpdated'; progress: TaskProgress }
  | { type: 'taskRunStart'; taskLabel: string }
  | { type: 'taskRunComplete'; taskLabel: string; accepted: number; rejected: number }
  | { type: 'supervisedRunStart' }
  | { type: 'supervisedRunComplete' }
  | { type: 'taskAutoCompleted'; taskLabel: string }
  | { type: 'taskCheckResult'; taskLabel: string; status: TaskCheckStatus; evidence: string[]; score: number }
  | { type: 'checkAllResults'; results: TaskCheckEntry[]; completedCount: number; totalCount: number }
  | { type: 'modelsLoaded'; models: AvailableModel[]; selectedModelId: string | null }
  | { type: 'modelChanged'; modelName: string; modelId: string }
  | { type: 'requirementsFormatChanged'; format: string }
  | { type: 'chatEntry'; role: 'user' | 'assistant'; text: string; stage: Stage }
  | { type: 'inquiryDone'; stage: Stage; answer: string }
  | { type: 'taskOutput'; text: string }
  | { type: 'promptsScaffolded'; specName: string }
  | { type: 'clarificationStreamStart' }
  | { type: 'clarificationStreamChunk'; chunk: string }
  | { type: 'clarificationStreamDone'; questions: string }
  | { type: 'clarificationError'; message: string };
