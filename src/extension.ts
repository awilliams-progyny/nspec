import * as vscode from 'vscode';
import { SpecPanelProvider } from './SpecPanelProvider';
import { loadHooks, scaffoldExamples } from './core/specStore';
import { runMatchingHooks, HookTrigger } from './core/hooks';
import { getSpecsRoot, getWorkspaceRoot } from './workspace';

let provider: SpecPanelProvider | undefined;
let hooksOutputChannel: vscode.OutputChannel | undefined;
let activationOutputChannel: vscode.OutputChannel | undefined;

function logActivation(message: string, err?: unknown) {
  const ts = new Date().toISOString();
  const suffix =
    err === undefined
      ? ''
      : ' :: ' + (err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
  activationOutputChannel?.appendLine(`[${ts}] ${message}${suffix}`);
}

export function activate(context: vscode.ExtensionContext) {
  activationOutputChannel = vscode.window.createOutputChannel('nSpec');
  context.subscriptions.push(activationOutputChannel);
  logActivation('Activation started');

  try {
    provider = new SpecPanelProvider(context);
    logActivation('SpecPanelProvider initialized');
  } catch (err) {
    logActivation('Activation failed during provider initialization', err);
    vscode.window.showErrorMessage(
      'nSpec: Failed to initialize extension. Check Output -> nSpec for details.'
    );
    return;
  }

  const runCommand = async (label: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage('nSpec: ' + label + ' failed - ' + message);
      console.error('[nSpec] Command failed:', label, err);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('nspec.open', () => {
      void runCommand('Open panel', async () => {
        provider!.show();
      });
    }),

    vscode.commands.registerCommand('nspec.newSpec', () => {
      void runCommand('New spec', async () => {
        provider!.show();
        provider!.triggerNewSpec();
      });
    }),

    vscode.commands.registerCommand('nspec.pickModel', () => {
      void runCommand('Select model', async () => {
        provider!.show();
        await provider!.pickModel();
      });
    }),

    vscode.commands.registerCommand('nspec.setupSteering', () => {
      void runCommand('Setup steering', async () => {
        provider!.setupSteering();
      });
    }),

    vscode.commands.registerCommand('nspec.vibeToSpec', () => {
      void runCommand('Generate spec from conversation', async () => {
        provider!.show();
        await provider!.vibeToSpec();
      });
    }),

    vscode.commands.registerCommand('nspec.scaffoldPrompts', () => {
      void runCommand('Scaffold prompts', async () => {
        provider!.show();
        provider!.scaffoldPromptsCommand();
      });
    }),

    vscode.commands.registerCommand('nspec.checkTasks', () => {
      void runCommand('Check tasks', async () => {
        provider!.show();
        provider!.checkTasksCommand();
      });
    }),

    vscode.commands.registerCommand('nspec.validateSetup', () => {
      void runCommand('Validate setup', async () => {
        await validateSetup();
      });
    })
  );

  try {
    setupFileWatcher(context);
    logActivation('File watcher ready');
  } catch (err) {
    logActivation('File watcher setup failed', err);
    vscode.window.showWarningMessage(
      'nSpec: File watcher disabled due to setup error. Check Output -> nSpec.'
    );
  }

  try {
    setupHooksWatcher(context);
    logActivation('Hooks watcher ready');
  } catch (err) {
    logActivation('Hooks watcher setup failed', err);
    vscode.window.showWarningMessage(
      'nSpec: Hooks watcher disabled due to setup error. Check Output -> nSpec.'
    );
  }

  void promptExamplesIfNew().catch((err) => {
    logActivation('Examples prompt failed', err);
  });

  logActivation('Activation complete');
}

async function validateSetup() {
  const cfg = vscode.workspace.getConfiguration('nspec');
  const workspaceCount = vscode.workspace.workspaceFolders?.length ?? 0;
  const specsRoot = getSpecsRoot();
  const apiKey = cfg.get<string>('apiKey', '').trim();
  const allCommands = new Set(await vscode.commands.getCommands(true));

  const expectedNspecCommands = [
    'nspec.open',
    'nspec.newSpec',
    'nspec.pickModel',
    'nspec.setupSteering',
    'nspec.vibeToSpec',
    'nspec.scaffoldPrompts',
    'nspec.checkTasks',
    'nspec.validateSetup',
  ];

  const missingNspecCommands = expectedNspecCommands.filter((cmd) => !allCommands.has(cmd));
  const codexCommands = Array.from(allCommands)
    .filter((cmd) => cmd.toLowerCase().startsWith('codex.'))
    .sort();

  const report: string[] = [];
  report.push('nSpec Setup Validation');
  report.push('----------------------');
  report.push(`Workspace folders: ${workspaceCount > 0 ? workspaceCount : 'none'}`);
  report.push(`Specs folder: ${specsRoot ?? '(no workspace open)'}`);
  report.push(`API key configured: ${apiKey ? 'yes' : 'no'}`);
  report.push(`nSpec commands registered: ${expectedNspecCommands.length - missingNspecCommands.length}/${expectedNspecCommands.length}`);
  report.push(`Codex commands detected: ${codexCommands.length}`);
  if (codexCommands.length > 0) {
    report.push('Codex command sample: ' + codexCommands.slice(0, 8).join(', '));
  }
  if (missingNspecCommands.length > 0) {
    report.push('Missing nSpec commands: ' + missingNspecCommands.join(', '));
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  if (workspaceCount === 0) {
    warnings.push('No workspace folder is open.');
  }
  if (missingNspecCommands.length > 0) {
    errors.push('Some nSpec commands were not registered.');
  }
  if (codexCommands.length === 0) {
    warnings.push('No Codex commands detected. Run checked will not start Codex.');
  }
  if (!apiKey) {
    warnings.push('No nspec.apiKey is configured.');
  }

  report.push('');
  if (errors.length > 0) {
    report.push('Errors:');
    for (const err of errors) report.push(`- ${err}`);
  }
  if (warnings.length > 0) {
    report.push('Warnings:');
    for (const warn of warnings) report.push(`- ${warn}`);
  }
  if (errors.length === 0 && warnings.length === 0) {
    report.push('Status: OK');
  } else if (errors.length === 0) {
    report.push('Status: WARN');
  } else {
    report.push('Status: FAIL');
  }

  for (const line of report) {
    activationOutputChannel?.appendLine(line);
  }
  activationOutputChannel?.show(true);

  const actionLabel = 'Open nSpec Output';
  if (errors.length > 0) {
    const choice = await vscode.window.showErrorMessage(
      'nSpec: Setup validation failed. Check Output -> nSpec for details.',
      actionLabel
    );
    if (choice === actionLabel) activationOutputChannel?.show(true);
    return;
  }

  if (warnings.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      'nSpec: Setup validation completed with warnings. Check Output -> nSpec.',
      actionLabel
    );
    if (choice === actionLabel) activationOutputChannel?.show(true);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    'nSpec: Setup validation passed.',
    actionLabel
  );
  if (choice === actionLabel) activationOutputChannel?.show(true);
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
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  if (!wsFolder) {
    logActivation('Skipping file watcher: no workspace folder');
    return;
  }

  const config = vscode.workspace.getConfiguration('nspec');
  const specsFolder = config.get<string>('specsFolder', '.specs');

  // Watch markdown and JSON files inside the specs folder
  const mdPattern = new vscode.RelativePattern(wsFolder, `${specsFolder}/**/*.md`);
  const jsonPattern = new vscode.RelativePattern(wsFolder, `${specsFolder}/**/*.json`);

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
  activationOutputChannel = undefined;
}
