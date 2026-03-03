import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWorkspaceRoot } from './workspace';

interface StartCodexSessionOptions {
  extraContextFiles?: string[];
  codexTodo?: {
    filePath?: string;
    line?: number;
    comment?: string;
  };
}

export interface StartCodexSessionResult {
  started: boolean;
  commandId: string;
  availableCodexCommands: string[];
  sendCapableCommands: string[];
  failureReason: 'none' | 'no_codex_commands' | 'no_send_commands' | 'invoke_failed';
}

export function isCodexCommand(commandId: string): boolean {
  const id = commandId.toLowerCase();
  return id.startsWith('codex.') || id.startsWith('chatgpt.');
}

export function isSendCapableCodexCommand(commandId: string): boolean {
  const id = commandId.toLowerCase();
  if (!isCodexCommand(id)) return false;
  if (id === 'chatgpt.implementtodo') return true;
  if (/(send|prompt|submit|run|execute)/i.test(id)) return true;
  return false;
}

function getSpecContextFiles(specsFolder: string, specName: string): string[] {
  const wsRoot = getWorkspaceRoot();
  if (!wsRoot) return [];
  const files = ['requirements.md', 'design.md', 'tasks.md'] as const;
  return files
    .map((fileName) => path.resolve(wsRoot, specsFolder, specName, fileName))
    .filter((filePath) => fs.existsSync(filePath));
}

export function getCodexCommandCandidates(allCommands: Set<string>): string[] {
  const sendPreferred = [
    'chatgpt.implementTodo',
    'codex.chat.send',
    'codex.chat.submit',
    'codex.sendMessage',
    'codex.sendPrompt',
    'codex.runPrompt',
    'codex.execute',
    'codex.executePrompt',
  ];

  const availableCodex = Array.from(allCommands).filter(isSendCapableCodexCommand).sort();
  const heuristicSend = availableCodex.filter((cmd) =>
    /(implementtodo|send|prompt|submit|run|execute)$/i.test(cmd)
  );
  return Array.from(
    new Set([...sendPreferred.filter((cmd) => allCommands.has(cmd)), ...heuristicSend])
  );
}

async function tryStartCodexWithCommand(
  commandId: string,
  prompt: string,
  specsFolder: string,
  specName: string,
  options?: StartCodexSessionOptions
): Promise<boolean> {
  const extraContextFiles = options?.extraContextFiles ?? [];
  const contextFiles = Array.from(
    new Set([...getSpecContextFiles(specsFolder, specName), ...extraContextFiles])
  ).filter((filePath) => fs.existsSync(filePath));

  if (commandId.toLowerCase() === 'chatgpt.implementtodo') {
    const candidateFile =
      options?.codexTodo?.filePath && fs.existsSync(options.codexTodo.filePath)
        ? options.codexTodo.filePath
        : contextFiles[0];
    if (!candidateFile) return false;

    const line = Math.max(1, options?.codexTodo?.line ?? 1);
    const comment = options?.codexTodo?.comment?.trim() || prompt;
    const todoPayload = {
      fileName: encodeURIComponent(candidateFile),
      line,
      comment,
    };
    const attempts: unknown[][] = [
      [todoPayload],
      [{ ...todoPayload, fileName: candidateFile }],
      [candidateFile, line, comment],
      [todoPayload.comment],
    ];
    for (const args of attempts) {
      try {
        await vscode.commands.executeCommand(commandId, ...args);
        return true;
      } catch {
        // Try next argument shape.
      }
    }
    return false;
  }

  const contextUris = contextFiles.map((filePath) => vscode.Uri.file(filePath));
  const attempts: unknown[][] = [
    [{ prompt, autoSubmit: true, contextFiles }],
    [{ prompt, autoSubmit: true, contextUris }],
    [{ prompt, autoSubmit: true, files: contextFiles }],
    [{ prompt, autoSubmit: true, files: contextUris }],
    [{ prompt, autoSubmit: true, attachments: contextUris }],
    [{ prompt, autoSubmit: true, context: contextUris }],
    [{ prompt, autoSubmit: true }],
    [{ prompt }],
    [prompt, contextUris],
    [prompt, contextFiles],
    [prompt],
  ];

  for (const args of attempts) {
    try {
      await vscode.commands.executeCommand(commandId, ...args);
      return true;
    } catch {
      // Try next argument shape.
    }
  }
  return false;
}

export async function detectCodexCommands(
  allCommands?: Set<string>
): Promise<{ all: string[]; sendCapable: string[]; candidates: string[] }> {
  const commandSet = allCommands ?? new Set(await vscode.commands.getCommands(true));
  const all = Array.from(commandSet).filter(isCodexCommand).sort();
  const sendCapable = all.filter(isSendCapableCodexCommand);
  const candidates = getCodexCommandCandidates(commandSet);
  return { all, sendCapable, candidates };
}

export async function startCodexSession(
  prompt: string,
  specsFolder: string,
  specName: string,
  allCommands?: Set<string>,
  options?: StartCodexSessionOptions
): Promise<StartCodexSessionResult> {
  const commandSet = allCommands ?? new Set(await vscode.commands.getCommands(true));
  const availableCodexCommands = Array.from(commandSet).filter(isCodexCommand).sort();
  const sendCapableCommands = availableCodexCommands.filter(isSendCapableCodexCommand);
  const candidates = getCodexCommandCandidates(commandSet);
  if (availableCodexCommands.length === 0) {
    return {
      started: false,
      commandId: 'none',
      availableCodexCommands,
      sendCapableCommands,
      failureReason: 'no_codex_commands',
    };
  }

  if (sendCapableCommands.length === 0 || candidates.length === 0) {
    return {
      started: false,
      commandId: 'none',
      availableCodexCommands,
      sendCapableCommands,
      failureReason: 'no_send_commands',
    };
  }

  for (const commandId of candidates) {
    const ok = await tryStartCodexWithCommand(commandId, prompt, specsFolder, specName, options);
    if (ok) {
      return {
        started: true,
        commandId,
        availableCodexCommands,
        sendCapableCommands,
        failureReason: 'none',
      };
    }
  }

  return {
    started: false,
    commandId: 'none',
    availableCodexCommands,
    sendCapableCommands,
    failureReason: 'invoke_failed',
  };
}
