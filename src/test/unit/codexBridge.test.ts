import { describe, expect, it, vi, beforeEach } from 'vitest';

const { executeCommandMock, getCommandsMock } = vi.hoisted(() => ({
  executeCommandMock: vi.fn(),
  getCommandsMock: vi.fn(async () => [] as string[]),
}));

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
  },
  commands: {
    executeCommand: executeCommandMock,
    getCommands: getCommandsMock,
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
  },
}));

import {
  getCodexCommandCandidates,
  isCodexCommand,
  isSendCapableCodexCommand,
  startCodexSession,
} from '../../codexBridge';

describe('codexBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('identifies codex/chatgpt commands', () => {
    expect(isCodexCommand('codex.startSession')).toBe(true);
    expect(isCodexCommand('chatgpt.newChat')).toBe(true);
    expect(isCodexCommand('workbench.action.reloadWindow')).toBe(false);
  });

  it('classifies only true send-capable commands', () => {
    expect(isSendCapableCodexCommand('chatgpt.implementTodo')).toBe(true);
    expect(isSendCapableCodexCommand('codex.executePrompt')).toBe(true);
    expect(isSendCapableCodexCommand('chatgpt.addToThread')).toBe(false);
    expect(isSendCapableCodexCommand('chatgpt.openSidebar')).toBe(false);
  });

  it('returns preferred command candidates first', () => {
    const commands = new Set<string>([
      'chatgpt.openSidebar',
      'chatgpt.implementTodo',
      'chatgpt.addToThread',
      'codex.executePrompt',
      'codex.unrelatedCommand',
      'workbench.action.reloadWindow',
    ]);

    const candidates = getCodexCommandCandidates(commands);
    expect(candidates[0]).toBe('chatgpt.implementTodo');
    expect(candidates).toContain('codex.executePrompt');
    expect(candidates).not.toContain('chatgpt.openSidebar');
    expect(candidates).not.toContain('chatgpt.addToThread');
    expect(candidates).not.toContain('workbench.action.reloadWindow');
  });

  it('passes extra context files into command invocation', async () => {
    executeCommandMock.mockResolvedValue(undefined);
    const extraFile = `${process.cwd()}/package.json`;

    const result = await startCodexSession(
      'probe prompt',
      '.specs',
      'bridge-probe',
      new Set(['chatgpt.implementTodo']),
      { extraContextFiles: [extraFile] }
    );

    expect(result.started).toBe(true);
    expect(result.commandId).toBe('chatgpt.implementTodo');
    expect(executeCommandMock).toHaveBeenCalled();
    const firstCallArgs = executeCommandMock.mock.calls[0];
    expect(firstCallArgs[0]).toBe('chatgpt.implementTodo');
    const payload = firstCallArgs[1] as { fileName?: string; line?: number; comment?: string };
    expect(payload.fileName).toBe(encodeURIComponent(extraFile));
    expect(payload.line).toBe(1);
    expect(payload.comment).toContain('probe prompt');
  });

  it('fails with no_codex_commands when no codex/chatgpt command exists', async () => {
    const result = await startCodexSession('probe', '.specs', 'bridge-probe', new Set(['nspec.open']));
    expect(result.started).toBe(false);
    expect(result.failureReason).toBe('no_codex_commands');
    expect(result.availableCodexCommands).toEqual([]);
  });

  it('tries next candidate when first command invocation fails', async () => {
    const extraFile = `${process.cwd()}/package.json`;
    executeCommandMock.mockImplementation((commandId: string) => {
      if (commandId === 'chatgpt.implementTodo') {
        throw new Error('first failed');
      }
      return Promise.resolve(undefined);
    });

    const result = await startCodexSession(
      'probe',
      '.specs',
      'bridge-probe',
      new Set(['chatgpt.implementTodo', 'codex.executePrompt']),
      { extraContextFiles: [extraFile] }
    );

    expect(result.started).toBe(true);
    expect(result.commandId).toBe('codex.executePrompt');
    expect(executeCommandMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('does not report success when only bootstrap/open commands exist', async () => {
    const result = await startCodexSession(
      'probe',
      '.specs',
      'bridge-probe',
      new Set(['chatgpt.openSidebar', 'chatgpt.newCodexPanel', 'codex.openChat'])
    );
    expect(result.started).toBe(false);
    expect(result.failureReason).toBe('no_send_commands');
  });

  it('returns no_send_commands when only non-send codex commands are present', async () => {
    const result = await startCodexSession(
      'probe',
      '.specs',
      'bridge-probe',
      new Set(['chatgpt.newChat', 'chatgpt.addToThread', 'chatgpt.addFileToThread'])
    );
    expect(result.started).toBe(false);
    expect(result.failureReason).toBe('no_send_commands');
  });
});
