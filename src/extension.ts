import * as vscode from 'vscode';
import { SpecPanelProvider } from './SpecPanelProvider';
import { loadHooks, scaffoldExamples } from './core/specStore';
import { runMatchingHooks, HookTrigger } from './core/hooks';
import { getSpecsRoot, getWorkspaceRoot } from './workspace';
import {
  getCodexApiConfig,
  getCodexApiConfigOrThrow,
  getCodexModelDiagnostics,
  summarizeAvailableModels,
  type CodexModelDiagnostics,
} from './lmClient';

let provider: SpecPanelProvider | undefined;
let hooksOutputChannel: vscode.OutputChannel | undefined;
let activationOutputChannel: vscode.OutputChannel | undefined;
type NspecProviderMode = 'codex_api' | 'codex_delegate';

function isCodexCommand(commandId: string): boolean {
  const id = commandId.toLowerCase();
  return id.startsWith('codex.') || id.startsWith('chatgpt.');
}

function getProviderMode(): NspecProviderMode {
  const mode = vscode.workspace.getConfiguration('nspec').get<string>('provider', 'codex_delegate');
  return mode === 'codex_api' ? 'codex_api' : 'codex_delegate';
}

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
    }),

    vscode.commands.registerCommand('nspec.diagnoseCodex', () => {
      void runCommand('Diagnose Codex models', async () => {
        await diagnoseCodexModels();
      });
    })
  );

  void ensureCodexAvailableAtStartup().catch((err) => {
    logActivation('Startup Codex availability check failed', err);
  });

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

function formatModelLine(model: { id: string; vendor: string; family: string; name: string }): string {
  return `${model.id} | ${model.vendor} | ${model.family} | ${model.name}`;
}

function codexModelFailureMessage(reason: CodexModelDiagnostics['unavailableReason']): string {
  if (reason === 'none') return 'Codex-compatible LM detected.';
  if (reason === 'noProviders') return 'No VS Code LM providers detected.';
  if (reason === 'copilotOnly') return 'Only Copilot/GitHub models are exposed via vscode.lm.';
  return 'VS Code LM has providers, but none look Codex-compatible.';
}

async function ensureCodexAvailableAtStartup() {
  try {
    const mode = getProviderMode();
    if (mode === 'codex_api') {
      const cfg = getCodexApiConfigOrThrow();
      logActivation(
        `Startup Codex API check passed: model=${cfg.model}, baseUrl=${cfg.baseUrl}, keySource=${cfg.apiKeySource}`
      );
      return;
    }

    const commands = await vscode.commands.getCommands(true);
    const codexCommands = commands.filter(isCodexCommand);
    if (codexCommands.length === 0) {
      throw new Error(
        'No Codex/ChatGPT commands detected for delegate mode. Install/enable OpenAI extension and reload VS Code.'
      );
    }
    logActivation(
      `Startup Codex delegate check passed: commands=${codexCommands.slice(0, 8).join(', ')}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logActivation('Startup Codex provider check failed', err);
    void vscode.window.showErrorMessage(`nSpec: ${message}`);
  }
}

async function diagnoseCodexModels() {
  const mode = getProviderMode();
  const apiConfig = getCodexApiConfig();
  const codexExtension = vscode.extensions.getExtension('openai.chatgpt');
  const allCommands = await vscode.commands.getCommands(true);
  const codexCommands = allCommands.filter(isCodexCommand).sort();
  const diagnostics = await getCodexModelDiagnostics();
  const report: string[] = [];
  report.push('nSpec Codex Diagnostics');
  report.push('----------------------');
  report.push(`Provider mode: ${mode}`);
  report.push(`Codex API configured: ${apiConfig ? 'yes' : 'no'}`);
  if (apiConfig) {
    report.push(`Codex API model: ${apiConfig.model}`);
    report.push(`Codex API base URL: ${apiConfig.baseUrl}`);
    report.push(`Codex API key source: ${apiConfig.apiKeySource}`);
  } else {
    report.push('Codex API key source: (none)');
  }
  report.push(`Codex extension installed: ${codexExtension ? 'yes' : 'no'}`);
  report.push(`Codex/ChatGPT commands detected: ${codexCommands.length}`);
  if (codexCommands.length > 0) {
    report.push(`Command sample: ${codexCommands.slice(0, 8).join(', ')}`);
  }
  report.push(`Detected models: ${diagnostics.allModels.length}`);
  report.push(`Selector matches: ${diagnostics.selectorMatches.length}`);
  report.push(`Marker matches: ${diagnostics.markerMatches.length}`);
  report.push(`Blocked matches: ${diagnostics.blockedMatches.length}`);
  report.push(`Codex candidates: ${diagnostics.codexCandidates.length}`);
  report.push(`Unavailable reason: ${diagnostics.unavailableReason}`);
  report.push('');
  report.push('All models:');
  report.push('  ' + summarizeAvailableModels(diagnostics.allModels));
  report.push('Selector matches:');
  report.push('  ' + summarizeAvailableModels(diagnostics.selectorMatches));
  report.push('Marker matches:');
  report.push('  ' + summarizeAvailableModels(diagnostics.markerMatches));
  if (diagnostics.blockedMatches.length > 0) {
    report.push('Blocked models:');
    report.push(
      '  ' +
        diagnostics.blockedMatches
          .map((entry) => `${formatModelLine(entry.model)} [${entry.reasons.join(', ')}]`)
          .join(' ; ')
    );
  }
  report.push('Selected model:');
  report.push(
    '  ' + (diagnostics.selectedModel ? formatModelLine(diagnostics.selectedModel) : '(none)')
  );

  for (const line of report) {
    activationOutputChannel?.appendLine(line);
  }
  activationOutputChannel?.show(true);

  if (mode === 'codex_delegate') {
    if (codexCommands.length > 0) {
      await vscode.window.showInformationMessage(
        'nSpec: Delegate mode is ready (Codex/ChatGPT commands detected). See Output -> nSpec for diagnostics.'
      );
      return;
    }
    await vscode.window.showErrorMessage(
      'nSpec: Delegate mode is selected, but no Codex/ChatGPT commands were detected. Install/enable the OpenAI extension and reload window.'
    );
    return;
  }

  if (apiConfig) {
    await vscode.window.showInformationMessage(
      'nSpec: Codex API mode is configured. See Output -> nSpec for diagnostics.'
    );
    return;
  }

  await vscode.window.showErrorMessage(
    'nSpec: Codex API mode is selected, but API key is not configured. Set `nspec.apiKey` or `NSPEC_API_KEY`/`OPENAI_API_KEY`.'
  );
}

async function validateSetup() {
  const providerMode = getProviderMode();
  const workspaceCount = vscode.workspace.workspaceFolders?.length ?? 0;
  const specsRoot = getSpecsRoot();
  const apiConfig = getCodexApiConfig();
  const allCommands = new Set(await vscode.commands.getCommands(true));
  const codexExtension = vscode.extensions.getExtension('openai.chatgpt');

  let diagnostics: CodexModelDiagnostics | null = null;
  let lmLookupError = '';
  try {
    diagnostics = await getCodexModelDiagnostics();
  } catch (err) {
    lmLookupError = err instanceof Error ? err.message : String(err);
  }

  const expectedNspecCommands = [
    'nspec.open',
    'nspec.newSpec',
    'nspec.setupSteering',
    'nspec.vibeToSpec',
    'nspec.scaffoldPrompts',
    'nspec.checkTasks',
    'nspec.validateSetup',
    'nspec.diagnoseCodex',
  ];

  const missingNspecCommands = expectedNspecCommands.filter((cmd) => !allCommands.has(cmd));
  const codexCommands = Array.from(allCommands).filter(isCodexCommand).sort();
  const codexApiReady = apiConfig !== null;

  const report: string[] = [];
  report.push('nSpec Setup Validation');
  report.push('----------------------');
  report.push(`Provider mode: ${providerMode}`);
  report.push(`Workspace folders: ${workspaceCount > 0 ? workspaceCount : 'none'}`);
  report.push(`Specs folder: ${specsRoot ?? '(no workspace open)'}`);
  report.push(`Codex API configured: ${codexApiReady ? 'yes' : 'no'}`);
  if (apiConfig) {
    report.push(`Codex API model: ${apiConfig.model}`);
    report.push(`Codex API base URL: ${apiConfig.baseUrl}`);
    report.push(`Codex API key source: ${apiConfig.apiKeySource}`);
  }
  report.push(`OpenAI Codex extension detected: ${codexExtension ? 'yes' : 'no'}`);
  report.push(`Codex/ChatGPT commands detected: ${codexCommands.length}`);
  if (codexCommands.length > 0) {
    report.push(`Command sample: ${codexCommands.slice(0, 8).join(', ')}`);
  }

  if (diagnostics) {
    report.push(`vscode.lm models available: ${diagnostics.allModels.length}`);
    report.push(`Codex selector matches: ${diagnostics.selectorMatches.length}`);
    report.push(`Codex marker matches: ${diagnostics.markerMatches.length}`);
    report.push(`Codex candidates after blocklist: ${diagnostics.codexCandidates.length}`);
    report.push(`vscode.lm status: ${codexModelFailureMessage(diagnostics.unavailableReason)}`);
    report.push('Discovered vscode.lm models: ' + summarizeAvailableModels(diagnostics.allModels));
    if (diagnostics.blockedMatches.length > 0) {
      const blocked = diagnostics.blockedMatches
        .map((entry) => `${entry.model.id} [${entry.reasons.join(', ')}]`)
        .join(' ; ');
      report.push('Blocked Codex candidates: ' + blocked);
    }
    if (diagnostics.selectedModel) {
      report.push('Selected Codex model: ' + formatModelLine(diagnostics.selectedModel));
    }
  }

  if (lmLookupError) {
    report.push(`vscode.lm lookup error: ${lmLookupError.slice(0, 240)}`);
  }

  report.push(
    `nSpec commands registered: ${expectedNspecCommands.length - missingNspecCommands.length}/${expectedNspecCommands.length}`
  );
  if (missingNspecCommands.length > 0) {
    report.push('Missing nSpec commands: ' + missingNspecCommands.join(', '));
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  if (workspaceCount === 0) warnings.push('No workspace folder is open.');
  if (missingNspecCommands.length > 0) errors.push('Some nSpec commands were not registered.');
  if (providerMode === 'codex_api' && !codexApiReady) {
    errors.push(
      'Codex API key is not configured. Set nSpec setting `nspec.apiKey` or environment variable `NSPEC_API_KEY`/`OPENAI_API_KEY`.'
    );
  }
  if (providerMode === 'codex_delegate' && codexCommands.length === 0) {
    errors.push(
      'Delegate mode requires Codex/ChatGPT commands (`codex.*` or `chatgpt.*`), but none were found.'
    );
  }
  if (!codexExtension && !codexApiReady) {
    warnings.push('OpenAI Codex extension is not installed or enabled.');
  }
  if (lmLookupError) warnings.push('Could not query VS Code language models.');

  report.push('');
  if (errors.length > 0) {
    report.push('Errors:');
    for (const err of errors) report.push(`- ${err}`);
  }
  if (warnings.length > 0) {
    report.push('Warnings:');
    for (const warn of warnings) report.push(`- ${warn}`);
  }
  report.push(errors.length === 0 ? (warnings.length === 0 ? 'Status: OK' : 'Status: WARN') : 'Status: FAIL');

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
