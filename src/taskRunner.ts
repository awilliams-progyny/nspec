import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LMClient, ProposedChange, ToolDefinition } from './lmClient';
import { buildTaskExecutionPrompt } from './core/prompts';

export interface ParsedTask {
  line: number;
  indent: number;
  checked: boolean;
  label: string;
  children: ParsedTask[];
}

export interface DiffReviewItem {
  change: ProposedChange;
  accepted: boolean;
}

export interface TaskRunResult {
  taskLabel: string;
  proposed: ProposedChange[];
  accepted: ProposedChange[];
  rejected: ProposedChange[];
}

const CHECKBOX_RE = /^(\s*)-\s+\[( |x|X)\]\s+(.+?)(?:\s+\([SMLX]+\))?$/;

export function parseTasks(markdown: string): ParsedTask[] {
  const lines = markdown.split('\n');
  const roots: ParsedTask[] = [];
  const stack: ParsedTask[] = [];

  lines.forEach((line, index) => {
    const match = CHECKBOX_RE.exec(line);
    if (!match) return;

    const indent = match[1].length;
    const checked = match[2].toLowerCase() === 'x';
    const label = match[3].trim();

    const task: ParsedTask = { line: index, indent, checked, label, children: [] };

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(task);
    } else {
      stack[stack.length - 1].children.push(task);
    }
    stack.push(task);
  });

  return roots;
}

// ── Tool definitions for vscode.lm ───────────────────────────────────────

const EXECUTION_TOOLS: ToolDefinition[] = [
  {
    name: 'writeFile',
    description: 'Create or overwrite a file in the workspace',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'editFile',
    description: 'Apply a targeted edit to an existing file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path' },
        oldText: { type: 'string', description: 'Exact text to replace' },
        newText: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    name: 'runCommand',
    description: 'Run a shell command in the workspace',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
      required: ['command'],
    },
  },
];

// ── TaskRunner ────────────────────────────────────────────────────────────

export class TaskRunner {
  private terminal: vscode.Terminal | null = null;
  private onOutput: (text: string) => void;
  private cancelled = false;

  constructor(onOutput: (text: string) => void) {
    this.onOutput = onOutput;
  }

  cancelRun() {
    this.cancelled = true;
  }

  // ── Supervised single-task execution ──────────────────────────────────

  async runTaskSupervised(
    ai: LMClient,
    taskLabel: string,
    requirements: string,
    design: string,
    workspaceContext: string,
    workspaceRoot: string,
    token?: vscode.CancellationToken
  ): Promise<TaskRunResult> {
    this.onOutput(`Generating changes for: ${taskLabel}`);

    const systemPrompt = buildTaskExecutionPrompt(
      requirements,
      design,
      taskLabel,
      workspaceContext
    );
    const userPrompt = `Implement the following task:\n\n${taskLabel}\n\nUse the tools to make the necessary file changes.`;

    const proposed = await ai.sendRequestWithTools(
      systemPrompt,
      userPrompt,
      EXECUTION_TOOLS,
      token
    );

    if (proposed.length === 0) {
      this.onOutput(`No changes proposed for: ${taskLabel}`);
      return { taskLabel, proposed: [], accepted: [], rejected: [] };
    }

    this.onOutput(`${proposed.length} change(s) proposed for: ${taskLabel}`);

    // Show diffs and collect accept/reject decisions
    const accepted: ProposedChange[] = [];
    const rejected: ProposedChange[] = [];

    for (const change of proposed) {
      if (token?.isCancellationRequested) break;

      const isAccepted = await this.reviewChange(change, workspaceRoot);
      if (isAccepted) {
        accepted.push(change);
      } else {
        rejected.push(change);
      }
    }

    // Apply accepted changes
    for (const change of accepted) {
      await this.applyChange(change, workspaceRoot);
    }

    this.onOutput(`Task "${taskLabel}": ${accepted.length} accepted, ${rejected.length} rejected`);

    return { taskLabel, proposed, accepted, rejected };
  }

  // ── Supervised run-all ────────────────────────────────────────────────

  async runAllSupervised(
    ai: LMClient,
    tasksMarkdown: string,
    requirements: string,
    design: string,
    workspaceContext: string,
    workspaceRoot: string,
    onTaskComplete: (taskLabel: string) => void,
    token?: vscode.CancellationToken
  ): Promise<TaskRunResult[]> {
    const tasks = parseTasks(tasksMarkdown);
    const flat = flattenTasks(tasks);
    const unchecked = flat.filter((t) => !t.checked);
    this.cancelled = false;

    if (unchecked.length === 0) {
      this.onOutput('All tasks are already completed!');
      return [];
    }

    this.onOutput(`Running ${unchecked.length} task(s) with supervised execution...\n`);

    const results: TaskRunResult[] = [];

    for (const task of unchecked) {
      if (this.cancelled || token?.isCancellationRequested) {
        this.onOutput(`Run cancelled. ${results.length} task(s) completed.`);
        break;
      }

      const result = await this.runTaskSupervised(
        ai,
        task.label,
        requirements,
        design,
        workspaceContext,
        workspaceRoot,
        token
      );
      results.push(result);

      if (result.accepted.length > 0) {
        onTaskComplete(task.label);
      }
    }

    // Summary
    const totalAccepted = results.reduce((sum, r) => sum + r.accepted.length, 0);
    const totalRejected = results.reduce((sum, r) => sum + r.rejected.length, 0);
    this.onOutput(
      `\nRun complete: ${results.length} task(s), ${totalAccepted} changes accepted, ${totalRejected} rejected`
    );

    return results;
  }

  // ── Legacy terminal-based run ─────────────────────────────────────────

  async runAll(tasksMarkdown: string): Promise<void> {
    const tasks = parseTasks(tasksMarkdown);
    const flat = flattenTasks(tasks);
    const unchecked = flat.filter((t) => !t.checked);

    if (unchecked.length === 0) {
      this.onOutput('All tasks are already completed!');
      return;
    }

    this.onOutput(`Running ${unchecked.length} task(s)...\n`);

    const terminal = this.getOrCreateTerminal();
    terminal.show(true);

    for (const task of unchecked) {
      this.onOutput(`> ${task.label}`);
      terminal.sendText(`echo "# nSpec: ${task.label.replace(/"/g, "'")}"`);
      await delay(300);
    }

    this.onOutput('\nTasks listed in terminal. Execute them to mark progress.');
  }

  async runSingle(taskLabel: string): Promise<void> {
    const terminal = this.getOrCreateTerminal();
    terminal.show(true);
    terminal.sendText(`echo "# nSpec Task: ${taskLabel.replace(/"/g, "'")}"`);
    this.onOutput(`> Started: ${taskLabel}`);
  }

  dispose() {
    this.terminal?.dispose();
  }

  // ── Diff review ───────────────────────────────────────────────────────

  private async reviewChange(change: ProposedChange, workspaceRoot: string): Promise<boolean> {
    if (change.type === 'runCommand') {
      return this.reviewCommand(change.command || '');
    }

    if (change.type === 'writeFile' && change.path && change.content) {
      return this.reviewFileWrite(change.path, change.content, workspaceRoot);
    }

    if (change.type === 'editFile' && change.path && change.oldText && change.newText) {
      return this.reviewFileEdit(change.path, change.oldText, change.newText, workspaceRoot);
    }

    return false;
  }

  private async reviewFileWrite(
    relPath: string,
    content: string,
    workspaceRoot: string
  ): Promise<boolean> {
    const absPath = path.join(workspaceRoot, relPath);
    const originalUri = vscode.Uri.file(absPath);

    // Write proposed content to temp file
    const specsFolder =
      vscode.workspace.getConfiguration('nspec').get<string>('specsFolder') || '.specs';
    const tempDir = path.join(workspaceRoot, specsFolder, '_temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, path.basename(relPath));
    fs.writeFileSync(tempPath, content, 'utf-8');
    const tempUri = vscode.Uri.file(tempPath);

    // If original doesn't exist, create an empty temp for diff
    if (!fs.existsSync(absPath)) {
      const emptyPath = path.join(tempDir, `empty_${path.basename(relPath)}`);
      fs.writeFileSync(emptyPath, '', 'utf-8');
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(emptyPath),
        tempUri,
        `New file: ${relPath} (proposed)`
      );
    } else {
      await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        tempUri,
        `${relPath} (proposed changes)`
      );
    }

    const choice = await vscode.window.showInformationMessage(
      `Apply changes to ${relPath}?`,
      'Accept',
      'Reject'
    );

    // Clean up temp files
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* ok */
    }

    return choice === 'Accept';
  }

  private async reviewFileEdit(
    relPath: string,
    oldText: string,
    newText: string,
    workspaceRoot: string
  ): Promise<boolean> {
    const absPath = path.join(workspaceRoot, relPath);
    if (!fs.existsSync(absPath)) {
      this.onOutput(`File not found for edit: ${relPath}`);
      return false;
    }

    const original = fs.readFileSync(absPath, 'utf-8');
    const proposed = original.replace(oldText, newText);

    if (proposed === original) {
      this.onOutput(`Edit target text not found in ${relPath}, skipping`);
      return false;
    }

    // Write proposed version to temp
    const specsFolder =
      vscode.workspace.getConfiguration('nspec').get<string>('specsFolder') || '.specs';
    const tempDir = path.join(workspaceRoot, specsFolder, '_temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, path.basename(relPath));
    fs.writeFileSync(tempPath, proposed, 'utf-8');

    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(absPath),
      vscode.Uri.file(tempPath),
      `${relPath} (proposed edit)`
    );

    const choice = await vscode.window.showInformationMessage(
      `Apply edit to ${relPath}?`,
      'Accept',
      'Reject'
    );

    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* ok */
    }

    return choice === 'Accept';
  }

  private async reviewCommand(command: string): Promise<boolean> {
    // Check allow-list
    const allowedCommands = vscode.workspace
      .getConfiguration('nspec')
      .get<string[]>('allowedCommands', []);

    if (allowedCommands.some((allowed) => command.startsWith(allowed))) {
      return true;
    }

    const choice = await vscode.window.showWarningMessage(
      `nSpec wants to run: ${command}`,
      { modal: true },
      'Allow',
      'Reject'
    );

    return choice === 'Allow';
  }

  // ── Apply changes ─────────────────────────────────────────────────────

  private async applyChange(change: ProposedChange, workspaceRoot: string): Promise<void> {
    if (change.type === 'writeFile' && change.path && change.content) {
      const absPath = path.join(workspaceRoot, change.path);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, change.content, 'utf-8');
      this.onOutput(`  Wrote: ${change.path}`);
    }

    if (change.type === 'editFile' && change.path && change.oldText && change.newText) {
      const absPath = path.join(workspaceRoot, change.path);
      if (fs.existsSync(absPath)) {
        const content = fs.readFileSync(absPath, 'utf-8');
        fs.writeFileSync(absPath, content.replace(change.oldText, change.newText), 'utf-8');
        this.onOutput(`  Edited: ${change.path}`);
      }
    }

    if (change.type === 'runCommand' && change.command) {
      const terminal = this.getOrCreateTerminal();
      terminal.show(true);
      terminal.sendText(change.command);
      this.onOutput(`  Ran: ${change.command}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private getOrCreateTerminal(): vscode.Terminal {
    if (this.terminal && !this.terminal.exitStatus) {
      return this.terminal;
    }
    this.terminal = vscode.window.createTerminal({
      name: 'nSpec Tasks',
      iconPath: new vscode.ThemeIcon('notebook'),
    });
    return this.terminal;
  }
}

export function flattenTasks(tasks: ParsedTask[]): ParsedTask[] {
  const result: ParsedTask[] = [];
  for (const t of tasks) {
    result.push(t);
    if (t.children.length > 0) result.push(...flattenTasks(t.children));
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
