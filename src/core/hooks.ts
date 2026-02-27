import * as path from 'path';
import { exec } from 'child_process';
import { loadHooks, resolveHookAction, HookDefinition } from './specStore';

export type HookTrigger = 'onSave' | 'onCreate' | 'onDelete' | 'manual';

export interface HookResult {
  hook: HookDefinition;
  resolvedAction: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Match a file path against a glob pattern (simple implementation).
 * Supports **, *, and ? wildcards.
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  // Normalize separators
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // Convert glob to regex
  const regexStr = normalizedPattern
    .replace(/[.+^${}()|[\]]/g, '\\$&') // escape regex chars (not * and ?)
    .replace(/\*\*/g, '{{GLOBSTAR}}') // placeholder for **
    .replace(/\*/g, '[^/]*') // * matches anything except /
    .replace(/\?/g, '[^/]') // ? matches single char except /
    .replace(/\{\{GLOBSTAR\}\}/g, '.*'); // ** matches anything including /

  return new RegExp(`^${regexStr}$`).test(normalizedPath);
}

/**
 * Find hooks matching a given trigger and file path.
 */
export function findMatchingHooks(
  specsRoot: string,
  trigger: HookTrigger,
  filePath: string
): HookDefinition[] {
  const hooks = loadHooks(specsRoot);
  return hooks.filter((h) => h.trigger === trigger && matchGlob(h.glob, filePath));
}

/**
 * Execute a hook action as a shell command.
 */
export function executeHookAction(
  action: string,
  workspaceRoot: string
): Promise<HookResult & { hook: HookDefinition }> {
  // This is a lower-level executor — caller provides the resolved action
  return new Promise((resolve) => {
    exec(action, { cwd: workspaceRoot, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({
        hook: { name: '', trigger: 'manual', glob: '', action },
        resolvedAction: action,
        stdout: stdout?.toString() || '',
        stderr: stderr?.toString() || '',
        exitCode: error ? (error.code ?? 1) : 0,
      });
    });
  });
}

/**
 * Run all hooks matching a trigger and file path.
 */
export async function runMatchingHooks(
  specsRoot: string,
  workspaceRoot: string,
  trigger: HookTrigger,
  filePath: string,
  specName?: string
): Promise<HookResult[]> {
  const matching = findMatchingHooks(specsRoot, trigger, filePath);
  const results: HookResult[] = [];

  for (const hook of matching) {
    const vars: Record<string, string> = {
      filePath: filePath.replace(/\\/g, '/'),
      fileName: path.basename(filePath),
      workspaceRoot: workspaceRoot.replace(/\\/g, '/'),
      specName: specName || '',
    };
    const resolved = resolveHookAction(hook.action, vars);

    const result = await new Promise<HookResult>((resolve) => {
      exec(resolved, { cwd: workspaceRoot, timeout: 30000 }, (error, stdout, stderr) => {
        resolve({
          hook,
          resolvedAction: resolved,
          stdout: stdout?.toString() || '',
          stderr: stderr?.toString() || '',
          exitCode: error ? (error.code ?? 1) : 0,
        });
      });
    });

    results.push(result);
  }

  return results;
}
