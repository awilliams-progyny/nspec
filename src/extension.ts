import * as vscode from 'vscode';
import { SpecPanelProvider } from './SpecPanelProvider';
import { loadHooks, scaffoldExamples } from './core/specStore';
import { runMatchingHooks, HookTrigger } from './core/hooks';
import { registerChatParticipant } from './chatParticipant';
import { getSpecsRoot, getWorkspaceRoot } from './workspace';

let provider: SpecPanelProvider | undefined;
let hooksOutputChannel: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext) {
  provider = new SpecPanelProvider(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('nspec.open', () => {
      provider!.show();
    }),

    vscode.commands.registerCommand('nspec.newSpec', () => {
      provider!.show();
      provider!.triggerNewSpec();
    }),

    vscode.commands.registerCommand('nspec.pickModel', async () => {
      provider!.show();
      await provider!.pickModel();
    }),

    vscode.commands.registerCommand('nspec.setupSteering', () => {
      provider!.setupSteering();
    }),

    vscode.commands.registerCommand('nspec.vibeToSpec', async () => {
      provider!.show();
      await provider!.vibeToSpec();
    }),

    vscode.commands.registerCommand('nspec.scaffoldPrompts', () => {
      provider!.show();
      provider!.scaffoldPromptsCommand();
    }),

    vscode.commands.registerCommand('nspec.checkTasks', () => {
      provider!.show();
      provider!.checkTasksCommand();
    })
  );

  // ── @nspec chat participant (Copilot / Codex chat integration) ────────
  registerChatParticipant(context);

  // ── File watcher: auto-refresh panel when .specs/ changes externally ──────
  setupFileWatcher(context);

  // ── Hooks: file-save triggered automations ────────────────────────────────
  setupHooksWatcher(context);

  // ── Examples prompt: offer example customization files on first use ────────
  promptExamplesIfNew();
}

async function promptExamplesIfNew() {
  const config = vscode.workspace.getConfiguration('nspec');
  if (config.get<boolean>('showExamplesPrompt') === false) return;

  const specsRoot = getSpecsRoot();
  if (!specsRoot) return;

  // Only prompt when the .specs folder doesn't yet exist
  const fs = await import('fs');
  if (fs.existsSync(specsRoot)) return;

  const answer = await vscode.window.showInformationMessage(
    'Welcome to nSpec! Would you like example customization files (steering, role overrides, prompt templates) added to .specs/examples/?',
    'Generate Examples',
    'Not Now',
    "Don't Ask Again"
  );

  if (answer === 'Generate Examples') {
    try {
      const written = scaffoldExamples(specsRoot);
      vscode.window.showInformationMessage(
        `nSpec: Generated ${written.length} example file${written.length === 1 ? '' : 's'} in .specs/examples/`
      );
    } catch (err) {
      vscode.window.showErrorMessage(`nSpec: Failed to generate examples — ${String(err)}`);
    }
  } else if (answer === "Don't Ask Again") {
    await config.update('showExamplesPrompt', false, vscode.ConfigurationTarget.Global);
  }
}

function setupFileWatcher(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('nspec');
  const specsFolder = config.get<string>('specsFolder', '.specs');

  // Watch markdown and JSON files inside the specs folder
  const mdPattern = new vscode.RelativePattern(
    vscode.workspace.workspaceFolders?.[0] ?? '',
    `${specsFolder}/**/*.md`
  );
  const jsonPattern = new vscode.RelativePattern(
    vscode.workspace.workspaceFolders?.[0] ?? '',
    `${specsFolder}/**/*.json`
  );

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function onFileChange() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      provider?.refreshFromDisk();
    }, 500);
  }

  const mdWatcher = vscode.workspace.createFileSystemWatcher(mdPattern);
  const jsonWatcher = vscode.workspace.createFileSystemWatcher(jsonPattern);

  mdWatcher.onDidChange(onFileChange);
  mdWatcher.onDidCreate(onFileChange);
  mdWatcher.onDidDelete(onFileChange);

  jsonWatcher.onDidChange(onFileChange);
  jsonWatcher.onDidCreate(onFileChange);
  jsonWatcher.onDidDelete(onFileChange);

  context.subscriptions.push(mdWatcher, jsonWatcher);
}

function setupHooksWatcher(context: vscode.ExtensionContext) {
  const specsRoot = getSpecsRoot();
  if (!specsRoot) return;
  const wsRoot = getWorkspaceRoot();
  if (!wsRoot) return;

  // Check if any hooks are defined
  const hooks = loadHooks(specsRoot);
  if (hooks.length === 0) return;

  // Create output channel for hook logs
  hooksOutputChannel = vscode.window.createOutputChannel('nSpec Hooks');
  context.subscriptions.push(hooksOutputChannel);

  // Set up status bar indicator
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = `$(zap) ${hooks.length} hook${hooks.length === 1 ? '' : 's'}`;
  statusBarItem.tooltip = 'nSpec hooks active';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Watch for file save events and trigger matching hooks
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const relPath = vscode.workspace.asRelativePath(doc.uri, false);
      await triggerHooks(specsRoot, wsRoot, 'onSave', relPath);
    }),

    vscode.workspace.onDidCreateFiles(async (e) => {
      for (const uri of e.files) {
        const relPath = vscode.workspace.asRelativePath(uri, false);
        await triggerHooks(specsRoot, wsRoot, 'onCreate', relPath);
      }
    }),

    vscode.workspace.onDidDeleteFiles(async (e) => {
      for (const uri of e.files) {
        const relPath = vscode.workspace.asRelativePath(uri, false);
        await triggerHooks(specsRoot, wsRoot, 'onDelete', relPath);
      }
    })
  );

  // Re-scan hooks when hook files change
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) return;
  const hookPattern = new vscode.RelativePattern(
    wsFolder,
    `${vscode.workspace.getConfiguration('nspec').get<string>('specsFolder', '.specs')}/hooks/**/*.json`
  );
  const hookWatcher = vscode.workspace.createFileSystemWatcher(hookPattern);
  const refreshHookCount = () => {
    const updated = loadHooks(specsRoot);
    statusBarItem.text = `$(zap) ${updated.length} hook${updated.length === 1 ? '' : 's'}`;
  };
  hookWatcher.onDidChange(refreshHookCount);
  hookWatcher.onDidCreate(refreshHookCount);
  hookWatcher.onDidDelete(refreshHookCount);
  context.subscriptions.push(hookWatcher);
}

async function triggerHooks(
  specsRoot: string,
  wsRoot: string,
  trigger: HookTrigger,
  filePath: string
) {
  const results = await runMatchingHooks(specsRoot, wsRoot, trigger, filePath);
  for (const result of results) {
    hooksOutputChannel?.appendLine(
      `[${new Date().toLocaleTimeString()}] Hook: ${result.hook.name}`
    );
    hooksOutputChannel?.appendLine(`  Trigger: ${trigger} | File: ${filePath}`);
    hooksOutputChannel?.appendLine(`  Action: ${result.resolvedAction}`);
    if (result.stdout) hooksOutputChannel?.appendLine(`  stdout: ${result.stdout.trim()}`);
    if (result.stderr) hooksOutputChannel?.appendLine(`  stderr: ${result.stderr.trim()}`);
    hooksOutputChannel?.appendLine(`  Exit: ${result.exitCode}`);
    hooksOutputChannel?.appendLine('');
  }
}

export function deactivate() {
  provider = undefined;
  hooksOutputChannel = undefined;
}
