import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LMClient } from './lmClient';
import * as specManager from './specManager';
import type { ToExtensionMessage, FromExtensionMessage } from './webviewMessages';
import { getSpecsRoot, getWorkspaceRoot } from './workspace';
import { TaskRunner } from './taskRunner';
import {
  REFINE_SYSTEM,
  buildRefinementPrompt,
  buildVerificationPrompt,
  VIBE_TO_SPEC_SYSTEM,
  buildVibeToSpecPrompt,
  CLARIFICATION_SYSTEM,
  buildClarificationUserPrompt,
  buildClarifiedRequirementsUserPrompt,
} from './prompts';

type Stage = specManager.Stage;

interface ChatEntry {
  role: 'user' | 'assistant';
  text: string;
}

interface PanelState {
  activeSpec: string | null;
  activeStage: Stage;
  contents: Partial<Record<Stage, string>>;
  generating: boolean;
  cancelToken: vscode.CancellationTokenSource | null;
  chatHistory: Partial<Record<Stage, ChatEntry[]>>;
}

type ProviderMode = 'codex_api' | 'codex_delegate';

interface DelegateRequest {
  step_id: string;
  kind: 'generate' | 'refine' | 'transform';
  created_at: string;
  spec_name: string;
  stage: Stage;
  goal: string;
  inputs: {
    system_prompt: string;
    user_prompt: string;
    source_files: string[];
  };
  outputs: {
    target_files: string[];
    receipt_path: string;
  };
  rules: string[];
}

interface DelegateReceipt {
  step_id: string;
  status: 'ok' | 'error' | 'needs_input';
  outputs_written?: string[];
  message?: string;
}

function isCodexCommand(commandId: string): boolean {
  const id = commandId.toLowerCase();
  return id.startsWith('codex.') || id.startsWith('chatgpt.');
}

export class SpecPanelProvider {
  private panel: vscode.WebviewPanel | null = null;
  private context: vscode.ExtensionContext;
  private ai: LMClient;
  private taskRunner: TaskRunner;
  private lastWriteTs = 0;
  private state: PanelState = {
    activeSpec: null,
    activeStage: 'requirements',
    contents: {},
    generating: false,
    cancelToken: null,
    chatHistory: {},
  };

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.ai = new LMClient();

    this.taskRunner = new TaskRunner((text) => this.postMessage({ type: 'taskOutput', text }));
  }

  private getProviderMode(): ProviderMode {
    const mode = vscode.workspace.getConfiguration('nspec').get<string>('provider', 'codex_delegate');
    return mode === 'codex_api' ? 'codex_api' : 'codex_delegate';
  }

  private isDelegateMode(): boolean {
    return this.getProviderMode() === 'codex_delegate';
  }

  private getSpecsFolderName(): string {
    return vscode.workspace.getConfiguration('nspec').get<string>('specsFolder') || '.specs';
  }

  private toWorkspaceRelativePath(filePath: string): string {
    const wsRoot = this.getWorkspaceRoot();
    if (!wsRoot) return filePath;
    return path.relative(wsRoot, filePath) || filePath;
  }

  private collectDelegateSourceFiles(specName: string): string[] {
    const specsRoot = getSpecsRoot();
    if (!specsRoot) return [];

    const specRoot = path.join(specsRoot, specName);
    const candidates = ['requirements.md', 'design.md', 'tasks.md', 'verify.md'].map((name) =>
      path.join(specRoot, name)
    );

    return candidates.filter((file) => fs.existsSync(file)).map((file) => this.toWorkspaceRelativePath(file));
  }

  private async waitForDelegateReceipt(
    receiptPath: string,
    expectedStepId: string,
    token: vscode.CancellationToken,
    timeoutMs = 20 * 60 * 1000
  ): Promise<DelegateReceipt> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (token.isCancellationRequested) throw new Error('Generation cancelled.');

      if (fs.existsSync(receiptPath)) {
        try {
          const raw = fs.readFileSync(receiptPath, 'utf-8');
          const receipt = JSON.parse(raw) as DelegateReceipt;
          if (receipt.step_id !== expectedStepId) {
            await new Promise((resolve) => setTimeout(resolve, 700));
            continue;
          }
          return receipt;
        } catch {
          // Receipt might still be in-flight; keep waiting.
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 700));
    }

    throw new Error(
      'Timed out waiting for Codex delegate receipt. Open Codex and complete the request file manually, then retry.'
    );
  }

  private async runDelegateStageOperation(
    stage: Stage,
    kind: DelegateRequest['kind'],
    goal: string,
    systemPrompt: string,
    userPrompt: string,
    token: vscode.CancellationToken
  ): Promise<{ status: 'ok'; content: string } | { status: 'needs_input'; message: string }> {
    const specName = this.state.activeSpec;
    if (!specName) throw new Error('No active spec selected.');

    const specsRoot = getSpecsRoot();
    if (!specsRoot) throw new Error('No specs root found. Open a workspace folder first.');

    const specRoot = path.join(specsRoot, specName);
    const delegateRoot = path.join(specRoot, '.nspec');
    const inboxDir = path.join(delegateRoot, 'inbox');
    const outboxDir = path.join(delegateRoot, 'outbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });

    const stepId = `${Date.now()}-${kind}-${stage}`;
    const requestPath = path.join(inboxDir, `${stepId}.request.json`);
    const receiptPath = path.join(outboxDir, `${stepId}.done.json`);
    const targetFile = path.join(specRoot, `${stage}.md`);

    const relativeRequestPath = this.toWorkspaceRelativePath(requestPath);
    const relativeReceiptPath = this.toWorkspaceRelativePath(receiptPath);
    const relativeTargetPath = this.toWorkspaceRelativePath(targetFile);

    const request: DelegateRequest = {
      step_id: stepId,
      kind,
      created_at: new Date().toISOString(),
      spec_name: specName,
      stage,
      goal,
      inputs: {
        system_prompt: systemPrompt,
        user_prompt: userPrompt,
        source_files: this.collectDelegateSourceFiles(specName),
      },
      outputs: {
        target_files: [relativeTargetPath],
        receipt_path: relativeReceiptPath,
      },
      rules: [
        'Read the request JSON and follow it exactly.',
        `Write final markdown content to: ${relativeTargetPath}`,
        `Always write a done receipt JSON to: ${relativeReceiptPath}`,
        'Receipt shape: { step_id, status, outputs_written, message }',
        'Use status "needs_input" with a single concise question when blocked.',
      ],
    };

    fs.writeFileSync(requestPath, JSON.stringify(request, null, 2), 'utf-8');

    const delegatePrompt = [
      `Execute nSpec delegate request from file: ${relativeRequestPath}`,
      '',
      'Steps:',
      '1. Open and read the request JSON file.',
      '2. Perform the requested update on the target markdown file(s).',
      '3. Write the required receipt JSON file with status.',
      '4. Do not stop at chat-only output; file writes are required.',
      '',
      `Receipt path: ${relativeReceiptPath}`,
    ].join('\n');

    const allCommands = new Set(await vscode.commands.getCommands(true));
    const startResult = await this.startCodexSession(
      delegatePrompt,
      this.getSpecsFolderName(),
      specName,
      allCommands
    );

    if (!startResult.started) {
      const availableHint =
        startResult.availableCodexCommands.length > 0
          ? ' Available Codex/ChatGPT commands: ' +
            startResult.availableCodexCommands.slice(0, 8).join(', ')
          : '';
      const reason =
        startResult.failureReason === 'no_codex_commands'
          ? 'No Codex/ChatGPT commands available to run delegate mode.'
          : 'Could not auto-start Codex/ChatGPT delegate command.';
      throw new Error(reason + availableHint);
    }

    this.postMessage({
      type: 'taskOutput',
      text: `Delegate request queued: ${relativeRequestPath} via ${startResult.commandId}`,
    });

    const receipt = await this.waitForDelegateReceipt(receiptPath, stepId, token);
    if (receipt.status === 'needs_input') {
      return {
        status: 'needs_input',
        message: receipt.message || 'Codex requested more input.',
      };
    }
    if (receipt.status === 'error') {
      throw new Error(receipt.message || 'Codex delegate reported an error.');
    }
    if (!fs.existsSync(targetFile)) {
      throw new Error(`Delegate completed but output file was not written: ${relativeTargetPath}`);
    }

    return { status: 'ok', content: fs.readFileSync(targetFile, 'utf-8') };
  }

  // --- Public API ------------------------------------------------------------

  /** Called by the file watcher when .specs/ files change externally. */
  refreshFromDisk() {
    // Skip if the extension itself just wrote (within 1.5s)
    if (Date.now() - this.lastWriteTs < 1500) return;
    if (!this.panel) return;
    this.sendInit();
  }

  show() {
    try {
      if (this.panel) {
        // Always rebuild the webview document so local UI edits show up immediately.
        this.panel.webview.html = this.buildHtml(this.panel.webview);
        this.panel.reveal(vscode.ViewColumn.One);
        return;
      }
      this.createPanel();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage('nSpec: Failed to open panel - ' + message);
      console.error('[nSpec] show() failed:', err);
    }
  }

  triggerNewSpec() {
    this.show();
    setTimeout(() => this.postMessage({ type: 'triggerNewSpec' }), 400);
  }

  setupSteering() {
    const written = specManager.setupSteering();
    if (written.length === 0) {
      vscode.window.showWarningMessage(
        'nSpec: Could not infer steering files. Open a folder with a supported project (e.g. package.json or pyproject.toml) and try again.'
      );
    } else {
      vscode.window.showInformationMessage(
        `nSpec: Generated ${written.length} steering file(s): ${written.join(', ')}. Edit them to refine your project context.`
      );
    }
  }

  scaffoldPromptsCommand() {
    if (this.state.activeSpec) {
      specManager.scaffoldCustomPrompts(this.state.activeSpec);
      specManager.openFileInEditor(this.state.activeSpec, 'requirements');
      vscode.window.showInformationMessage(
        `nSpec: Created _prompts/ folder in ${this.state.activeSpec}. Drop .md files there to override stage prompts.`
      );
      this.postMessage({ type: 'promptsScaffolded', specName: this.state.activeSpec });
    } else {
      vscode.window.showWarningMessage(
        'nSpec: Open a spec first. Use the sidebar or New Spec to create one.'
      );
    }
  }

  checkTasksCommand() {
    if (this.state.activeSpec) {
      this.handleCheckAllTasks();
    } else {
      vscode.window.showWarningMessage(
        'nSpec: Open a spec first. Use the sidebar or New Spec to create one.'
      );
    }
  }

  async vibeToSpec() {
    if (!(await this.ensureWorkspaceOpen())) return;
    // Step 1: Ask for spec name
    const specName = await vscode.window.showInputBox({
      title: 'nSpec: Generate Spec from Conversation',
      prompt: 'Enter a name for the new spec',
      placeHolder: 'e.g., auth-feature',
    });
    if (!specName) return;

    // Step 2: Ask for transcript source
    const source = (await vscode.window.showQuickPick(
      [
        { label: 'From active editor selection', value: 'selection' },
        { label: 'From clipboard', value: 'clipboard' },
        { label: 'From file...', value: 'file' },
      ],
      {
        title: 'nSpec: Conversation Source',
        placeHolder: 'Where is the conversation transcript?',
      }
    )) as { label: string; value: string } | undefined;
    if (!source) return;

    let transcript = '';
    if (source.value === 'selection') {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage(
          'nSpec: No text selected. Select the text in the editor you want to use, then try again.'
        );
        return;
      }
      transcript = editor.document.getText(editor.selection);
    } else if (source.value === 'clipboard') {
      transcript = await vscode.env.clipboard.readText();
    } else if (source.value === 'file') {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Text files': ['md', 'txt', 'log'] },
        title: 'Select conversation transcript file',
      });
      if (!files || files.length === 0) return;
      transcript = fs.readFileSync(files[0].fsPath, 'utf-8');
    }

    if (!transcript.trim()) {
      vscode.window.showWarningMessage(
        'nSpec: Empty transcript. Paste or type content in the chat, then run the command again.'
      );
      return;
    }

    const folderName = specManager.toFolderName(specName);
    specManager.createSpecFolder(folderName);

    this.state.activeSpec = folderName;
    this.state.contents = {};
    this.state.activeStage = 'requirements';

    this.postMessage({
      type: 'specCreated',
      specName: folderName,
      displayName: specName,
      stage: 'requirements',
      progress: null,
      hasCustomPrompts: false,
      vibeSource: true,
    });

    // Step 3: Extract description from transcript via LLM
    let extractedDescription = '';
    await this.ai.streamCompletion(
      VIBE_TO_SPEC_SYSTEM,
      buildVibeToSpecPrompt(transcript),
      (chunk) => {
        extractedDescription += chunk;
      },
      () => {},
      (err: string) => {
        const clean = err.replace(/^[\s\S]*?Error:\s*/i, '').slice(0, 120);
        vscode.window.showErrorMessage(
          `nSpec: ${clean}${clean.length >= 120 ? '...' : ''}. Check Settings -> nSpec if it continues.`
        );
      }
    );

    // Step 4: Save vibe context
    specManager.writeVibeContext(folderName, {
      transcript:
        transcript.length > 10000 ? transcript.slice(0, 10000) + '\n\n[...truncated]' : transcript,
      extractedDescription,
      generatedAt: new Date().toISOString(),
    });

    // Step 5: Generate requirements with transcript as extended context
    const userPrompt = `${extractedDescription}\n\n---\n## Original Conversation Transcript\n${transcript}`;
    await this.streamGenerate('requirements', userPrompt, specName);

    vscode.window.showInformationMessage('nSpec: Spec generated from conversation transcript.');
  }

  // --- Panel lifecycle -------------------------------------------------------

  private createPanel() {
    try {
      this.panel = vscode.window.createWebviewPanel('nspec', 'nSpec', vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      });

      this.panel.iconPath = {
        light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png'),
        dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png'),
      };

      this.panel.webview.html = this.buildHtml(this.panel.webview);

      this.panel.webview.onDidReceiveMessage(
        (msg: ToExtensionMessage) => this.handleMessage(msg),
        undefined,
        this.context.subscriptions
      );

      this.panel.onDidDispose(
        () => {
          this.panel = null;
          this.taskRunner.dispose();
        },
        undefined,
        this.context.subscriptions
      );
    } catch (err) {
      this.panel = null;
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage('nSpec: Failed to create panel - ' + message);
      console.error('[nSpec] createPanel() failed:', err);
    }
  }

  private postMessage(msg: FromExtensionMessage) {
    this.panel?.webview.postMessage(msg);
  }

  // --- Message handling ------------------------------------------------------

  private async handleMessage(msg: ToExtensionMessage) {
    try {
      switch (msg.command) {
        case 'ready':
          await this.sendInit();
          break;

        case 'createSpec':
          await this.handleCreateSpec(msg.specName, msg.prompt, msg.specType, msg.template);
          break;

        case 'openSpec':
          await this.handleOpenSpec(msg.specName);
          break;

        case 'generateDesign':
          await this.handleGenerate('design');
          break;

        case 'generateTasks':
          await this.handleGenerate('tasks');
          break;

        case 'refine':
          await this.handleRefine(msg.stage, msg.feedback);
          break;

        case 'saveContent':
          this.handleSaveContent(msg.stage, msg.content);
          break;

        case 'setStage':
          this.state.activeStage = msg.stage;
          break;

        case 'runAllTasks':
          await this.handleRunTasks();
          break;

        case 'openInEditor':
          if (this.state.activeSpec) {
            specManager.openFileInEditor(this.state.activeSpec, msg.stage);
          }
          break;

        case 'deleteSpec':
          this.handleDeleteSpec(msg.specName);
          break;

        case 'generateVerify':
          await this.handleGenerateVerify();
          break;

        case 'toggleTask':
          this.handleToggleTask(msg.taskId);
          break;

        case 'setTaskState':
          this.handleSetTaskState(msg.taskId, msg.state);
          break;

        case 'setAllTasksState':
          this.handleSetAllTasksState(msg.state);
          break;

        case 'scaffoldPrompts':
          this.handleScaffoldPrompts();
          break;

        case 'cancelGeneration':
          this.state.cancelToken?.cancel();
          break;

        case 'validateSetup':
          await vscode.commands.executeCommand('nspec.validateSetup');
          break;

        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'nspec');
          break;

        case 'renameSpec':
          this.handleRenameSpec(msg.oldName, msg.newName);
          break;

        case 'cascadeFromStage':
          await this.handleCascadeFromStage(msg.fromStage);
          break;

        case 'generateRequirements':
          await this.handleGenerateRequirements();
          break;

        case 'runTask':
          await this.handleRunTaskSupervised(msg.taskLabel);
          break;

        case 'runAllTasksSupervised':
          await this.handleRunAllTasksSupervised();
          break;

        case 'checkTask':
          await this.handleCheckTask(msg.taskLabel);
          break;

        case 'checkAllTasks':
          await this.handleCheckAllTasks();
          break;

        case 'importFromFile':
          await this.handleImportFromFile();
          break;

        case 'setRequirementsFormat':
          await this.handleSetRequirementsFormat(msg.format);
          break;

        case 'cancelTaskRun':
          this.taskRunner.cancelRun();
          break;

        case 'startClarification':
          await this.handleStartClarification(
            msg.specName,
            msg.description,
            msg.specType,
            msg.template
          );
          break;

        case 'submitClarification':
          await this.handleSubmitClarification(
            msg.specName,
            msg.description,
            msg.specType,
            msg.qaTranscript,
            msg.template
          );
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'error', message });
      vscode.window.showErrorMessage(`nSpec: ${message}`);
    }
  }

  private async ensureWorkspaceOpen(): Promise<boolean> {
    if (this.getWorkspaceRoot()) return true;
    const choice = await vscode.window.showWarningMessage(
      'nSpec requires an open project folder.',
      'Open Folder'
    );
    if (choice === 'Open Folder') {
      await vscode.commands.executeCommand('vscode.openFolder');
    }
    return false;
  }

  // --- Init ------------------------------------------------------------------

  private async sendInit() {
    const specs = specManager.listSpecs().map((s) => ({
      name: s.name,
      hasRequirements: !!s.stages.requirements,
      hasDesign: !!s.stages.design,
      hasTasks: !!s.stages.tasks,
      hasVerify: !!s.stages.verify,
      progress: s.progress ?? null,
    }));

    const requirementsFormat =
      this.state.activeSpec != null
        ? (specManager.readConfig(this.state.activeSpec)?.requirementsFormat ?? undefined)
        : undefined;

    this.postMessage({
      type: 'init',
      specs,
      activeSpec: this.state.activeSpec,
      activeStage: this.state.activeStage,
      contents: this.state.contents,
      requirementsFormat,
    });
  }

  // --- Create spec -----------------------------------------------------------

  private async handleCreateSpec(
    specName: string,
    prompt: string,
    specType?: string,
    template?: string
  ) {
    if (!(await this.ensureWorkspaceOpen())) return;
    const effectivePrompt = prompt?.trim() || '';

    if (!specName?.trim()) {
      vscode.window.showWarningMessage('nSpec: Enter a spec name.');
      return;
    }
    if (!effectivePrompt) {
      vscode.window.showWarningMessage('nSpec: Enter a feature description.');
      return;
    }

    const folderName = specManager.toFolderName(specName);

    type GM = import('./core/specStore').GenerationMode;
    let mode: GM = 'requirements-first';
    if (specType === 'bugfix') mode = 'bugfix';
    else if (specType === 'design-first') mode = 'design-first';

    specManager.createSpecFolder(folderName, mode, template || undefined);

    const cfg = specManager.readConfig(folderName);
    if (cfg) {
      specManager.writeSpecConfig(folderName, { ...cfg, lightDesign: true });
    }

    if (template) {
      specManager.scaffoldTemplate(folderName, template);
    }

    this.state.activeSpec = folderName;
    this.state.contents = {};

    const firstStage: Stage = specType === 'design-first' ? 'design' : 'requirements';
    this.state.activeStage = firstStage;

    this.postMessage({
      type: 'specCreated',
      specName: folderName,
      displayName: specName,
      stage: firstStage,
      progress: null,
      hasCustomPrompts: !!template,
    });

    if (specType === 'bugfix') {
      await this.streamGenerate('requirements', effectivePrompt, specName);
    } else {
      await this.streamGenerate(firstStage, effectivePrompt, specName);
    }
  }

  // --- Guided clarification (D1 + D2) ----------------------------------------

  /** Stream AI clarifying questions back to the webview before spec creation. */
  private async handleStartClarification(
    specName: string,
    description: string,
    _specType: string,
    _template: string
  ) {
    if (this.isDelegateMode()) {
      this.postMessage({
        type: 'clarificationError',
        message:
          'Clarification streaming is unavailable in delegate mode. Continue with spec creation and refine after file generation.',
      });
      return;
    }

    if (!specName?.trim() || !description?.trim()) {
      this.postMessage({
        type: 'clarificationError',
        message: 'Spec name and description are required.',
      });
      return;
    }

    this.postMessage({ type: 'clarificationStreamStart' });
    let accumulated = '';

    try {
      await this.ai.streamCompletion(
        CLARIFICATION_SYSTEM,
        buildClarificationUserPrompt(description),
        (chunk) => {
          accumulated += chunk;
          this.postMessage({ type: 'clarificationStreamChunk', chunk });
        },
        () => {
          this.postMessage({ type: 'clarificationStreamDone', questions: accumulated });
        },
        (err: string) => {
          const clean = err.replace(/^[\s\S]*?Error:\s*/i, '').slice(0, 120);
          this.postMessage({ type: 'clarificationError', message: clean });
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'clarificationError', message: msg.slice(0, 120) });
    }
  }

  /** Create the spec and generate requirements using the clarified Q&A context. */
  private async handleSubmitClarification(
    specName: string,
    description: string,
    specType: string,
    qaTranscript: string,
    template: string
  ) {
    if (!(await this.ensureWorkspaceOpen())) return;
    if (!specName?.trim() || !description?.trim()) {
      vscode.window.showWarningMessage('nSpec: Spec name and description are required.');
      return;
    }

    const folderName = specManager.toFolderName(specName);
    type GM = import('./core/specStore').GenerationMode;
    let mode: GM = 'requirements-first';
    if (specType === 'bugfix') mode = 'bugfix';
    else if (specType === 'design-first') mode = 'design-first';

    specManager.createSpecFolder(folderName, mode, template || undefined);

    const cfg = specManager.readConfig(folderName);
    if (cfg) specManager.writeSpecConfig(folderName, { ...cfg, lightDesign: true });
    if (template) specManager.scaffoldTemplate(folderName, template);

    this.state.activeSpec = folderName;
    this.state.contents = {};
    this.state.activeStage = 'requirements';

    this.postMessage({
      type: 'specCreated',
      specName: folderName,
      displayName: specName,
      stage: 'requirements',
      progress: null,
      hasCustomPrompts: !!template,
    });

    const userPrompt = qaTranscript?.trim()
      ? buildClarifiedRequirementsUserPrompt(description, qaTranscript)
      : description;

    await this.streamGenerate('requirements', userPrompt, specName);
  }

  private async handleSetRequirementsFormat(format: 'given-when-then' | 'ears') {
    if (!this.state.activeSpec) return;
    const cfg = specManager.readConfig(this.state.activeSpec);
    if (!cfg) return;

    specManager.writeSpecConfig(this.state.activeSpec, { ...cfg, requirementsFormat: format });
    this.postMessage({ type: 'requirementsFormatChanged', format });

    // Immediately regenerate requirements so the selected format is applied to content.
    if (!this.state.generating && this.state.contents.requirements?.trim()) {
      this.state.activeStage = 'requirements';
      await this.handleGenerateRequirements();
    }
  }

  /** Import from file: show dialog, optionally transform with AI, then write stage (D5). */
  private async handleImportFromFile() {
    if (!this.state.activeSpec) {
      vscode.window.showWarningMessage('nSpec: Open a spec first.');
      return;
    }
    const files = await vscode.window.showOpenDialog({
      title: 'nSpec: Select file to import',
      canSelectMany: false,
      filters: {
        'Markdown / Text': ['md', 'txt', 'rst'],
        'All files': ['*'],
      },
    });
    if (!files || files.length === 0) return;
    const filePath = files[0].fsPath;

    const stagePick = await vscode.window.showQuickPick(
      [
        { label: 'Requirements', value: 'requirements' as Stage },
        { label: 'Design', value: 'design' as Stage },
        { label: 'Tasks', value: 'tasks' as Stage },
        { label: 'Verify', value: 'verify' as Stage },
      ],
      { title: 'Import into which stage?', placeHolder: 'Select stage' }
    );
    if (!stagePick) return;
    const stage = stagePick.value;

    const transformPick = await vscode.window.showQuickPick(
      [
        { label: 'Yes - transform with AI into spec format', value: true },
        { label: 'No - use file content as-is', value: false },
      ],
      { title: 'Transform with AI?', placeHolder: 'Choose' }
    );
    if (transformPick === undefined) return;
    const transform = transformPick.value;

    if (!transform) {
      specManager.importFile(this.state.activeSpec, stage, filePath);
      this.state.contents[stage] = specManager.readStage(this.state.activeSpec, stage) ?? '';
      const progress =
        stage === 'tasks' ? specManager.readTaskProgress(this.state.activeSpec) : null;
      const requirementsFormat =
        specManager.readConfig(this.state.activeSpec)?.requirementsFormat ?? undefined;
      this.postMessage({
        type: 'specOpened',
        specName: this.state.activeSpec,
        activeStage: this.state.activeStage,
        contents: this.state.contents,
        progress,
        hasCustomPrompts: specManager.hasCustomPrompts(this.state.activeSpec),
        requirementsFormat,
      });
      vscode.window.showInformationMessage(`nSpec: Imported file into ${stage}.md`);
      return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const assembled = specManager.assembleSystemPrompt(this.state.activeSpec, stage, {
      title: this.state.activeSpec,
    });
    if (!assembled) {
      this.postMessage({ type: 'error', message: 'Unable to assemble prompt context.' });
      return;
    }
    const systemPrompt = assembled.systemPrompt;
    const userPrompt = `Convert the following document into the proper ${stage} format for this spec.\n\n---\n\n${content}`;

    let accumulated = '';
    const cts = new vscode.CancellationTokenSource();
    this.postMessage({ type: 'streamStart', stage });
    try {
      if (this.isDelegateMode()) {
        const result = await this.runDelegateStageOperation(
          stage,
          'transform',
          `Transform imported document into ${stage}.md`,
          systemPrompt,
          userPrompt,
          cts.token
        );

        if (result.status === 'needs_input') {
          this.postMessage({ type: 'error', message: result.message });
          return;
        }

        accumulated = result.content;
        this.state.contents[stage] = accumulated;
        if (stage === 'tasks') {
          const progress = specManager.syncProgressFromMarkdown(this.state.activeSpec!, accumulated);
          this.postMessage({ type: 'progressUpdated', progress });
        }
        const currentSpec = this.state.activeSpec;
        this.postMessage({ type: 'streamDone', stage, content: accumulated });
        const requirementsFormat = currentSpec
          ? (specManager.readConfig(currentSpec)?.requirementsFormat ?? undefined)
          : undefined;
        this.postMessage({
          type: 'specOpened',
          specName: currentSpec ?? '',
          activeStage: this.state.activeStage,
          contents: this.state.contents,
          progress: currentSpec ? specManager.readTaskProgress(currentSpec) : null,
          hasCustomPrompts: currentSpec ? specManager.hasCustomPrompts(currentSpec) : false,
          requirementsFormat,
        });
        vscode.window.showInformationMessage(`nSpec: Imported and transformed into ${stage}.md`);
        return;
      }

      await this.ai.streamCompletion(
        systemPrompt,
        userPrompt,
        (chunk) => {
          accumulated += chunk;
          this.postMessage({ type: 'streamChunk', stage, chunk });
        },
        () => {
          specManager.writeStage(this.state.activeSpec!, stage, accumulated);
          this.state.contents[stage] = accumulated;
          if (stage === 'tasks') {
            const progress = specManager.syncProgressFromMarkdown(
              this.state.activeSpec!,
              accumulated
            );
            this.postMessage({ type: 'progressUpdated', progress });
          }
          const specName = this.state.activeSpec;
          this.postMessage({ type: 'streamDone', stage, content: accumulated });
          const requirementsFormat = specName
            ? (specManager.readConfig(specName)?.requirementsFormat ?? undefined)
            : undefined;
          this.postMessage({
            type: 'specOpened',
            specName: specName ?? '',
            activeStage: this.state.activeStage,
            contents: this.state.contents,
            progress: specName ? specManager.readTaskProgress(specName) : null,
            hasCustomPrompts: specName ? specManager.hasCustomPrompts(specName) : false,
            requirementsFormat,
          });
          vscode.window.showInformationMessage(`nSpec: Imported and transformed into ${stage}.md`);
        },
        (err: string) => {
          this.postMessage({ type: 'error', message: err });
        },
        cts.token
      );
    } finally {
      cts.dispose();
    }
  }

  // --- Open existing spec ----------------------------------------------------

  private async handleOpenSpec(specName: string) {
    const specs = specManager.listSpecs();
    const spec = specs.find((s) => s.name === specName);
    if (!spec) return;

    this.state.activeSpec = specName;
    this.state.contents = { ...spec.stages };

    // Sync task progress whenever we open a spec with tasks
    let progress = spec.progress ?? null;
    if (spec.stages.tasks) {
      progress = specManager.syncProgressFromMarkdown(specName, spec.stages.tasks);
    }

    // Navigate to furthest complete stage
    if (spec.stages.verify) this.state.activeStage = 'verify';
    else if (spec.stages.tasks) this.state.activeStage = 'tasks';
    else if (spec.stages.design) this.state.activeStage = 'design';
    else this.state.activeStage = 'requirements';

    const hasCustomPrompts = specManager.hasCustomPrompts(specName);
    const requirementsFormat = specManager.readConfig(specName)?.requirementsFormat ?? undefined;

    this.postMessage({
      type: 'specOpened',
      specName,
      activeStage: this.state.activeStage,
      contents: this.state.contents,
      progress,
      hasCustomPrompts,
      requirementsFormat,
    });
  }

  // --- Generate stage --------------------------------------------------------

  private async handleGenerate(stage: 'design' | 'tasks') {
    if (!this.state.activeSpec) return;
    const sourceStage: Stage = stage === 'design' ? 'requirements' : 'design';
    const sourceContent = this.state.contents[sourceStage];
    if (!sourceContent) {
      this.postMessage({
        type: 'error',
        message: `Please complete the ${sourceStage} stage first.`,
      });
      return;
    }
    await this.streamGenerate(stage, sourceContent, this.state.activeSpec);
  }

  private async handleGenerateVerify() {
    if (!this.state.activeSpec) return;
    const req = this.state.contents.requirements;
    const des = this.state.contents.design;
    const tasks = this.state.contents.tasks;

    if (!req || !des || !tasks) {
      this.postMessage({
        type: 'error',
        message: 'Verification requires Requirements, Design, and Tasks to all be complete.',
      });
      return;
    }

    const verifyPrompt = buildVerificationPrompt(req, des, tasks);
    await this.streamGenerate('verify', verifyPrompt, this.state.activeSpec);
  }

  private handleToggleTask(taskId: string) {
    if (!this.state.activeSpec) return;
    const progress = specManager.toggleTaskItem(this.state.activeSpec, taskId);
    if (progress) {
      this.postMessage({ type: 'progressUpdated', progress });
    }
  }

  private handleSetTaskState(taskId: string, state: 'checked' | 'empty') {
    if (!this.state.activeSpec) return;
    const progress = specManager.setTaskItemSelection(this.state.activeSpec, taskId, state);
    if (progress) {
      this.postMessage({ type: 'progressUpdated', progress });
    }
  }

  private handleSetAllTasksState(state: 'checked' | 'empty') {
    if (!this.state.activeSpec) return;
    const progress = specManager.setAllTaskSelections(this.state.activeSpec, state);
    if (progress) {
      this.postMessage({ type: 'progressUpdated', progress });
    }
  }

  private handleScaffoldPrompts() {
    if (!this.state.activeSpec) return;
    specManager.scaffoldCustomPrompts(this.state.activeSpec);
    specManager.openFileInEditor(this.state.activeSpec, 'requirements'); // open folder via file
    vscode.window.showInformationMessage(
      `nSpec: Created _prompts/ folder in ${this.state.activeSpec}. Drop .md files there to override stage prompts.`
    );
    this.postMessage({ type: 'promptsScaffolded', specName: this.state.activeSpec });
  }

  private async streamGenerate(stage: Stage, userContent: string, specTitle: string) {
    if (this.state.generating) {
      this.postMessage({
        type: 'error',
        message: 'Generation already in progress. Please wait or cancel first.',
      });
      return;
    }
    this.state.generating = true;

    const cts = new vscode.CancellationTokenSource();
    this.state.cancelToken = cts;

    const specName = this.state.activeSpec ?? '';
    const assembled = specManager.assembleSystemPrompt(specName, stage, { title: specTitle });
    if (!assembled) {
      this.state.generating = false;
      this.state.cancelToken = null;
      this.postMessage({ type: 'error', message: 'Unable to assemble prompt context.' });
      return;
    }

    const systemPrompt = assembled.systemPrompt;
    if (assembled.sourceMap.promptOverrideSource) {
      this.postMessage({ type: 'usingCustomPrompt', stage });
    }

    // Inject workspace context for design and tasks stages
    let finalUserContent = userContent;
    if (stage === 'design' || stage === 'tasks') {
      const wsContext = specManager.buildWorkspaceContext(specName);
      if (wsContext) {
        finalUserContent = `${userContent}\n\n${wsContext}`;
      }
    }

    this.postMessage({ type: 'streamStart', stage });

    let accumulated = '';

    if (this.isDelegateMode()) {
      try {
        const result = await this.runDelegateStageOperation(
          stage,
          'generate',
          `Generate ${stage}.md for spec ${specName}`,
          systemPrompt,
          finalUserContent,
          cts.token
        );

        this.state.generating = false;
        this.state.cancelToken = null;

        if (result.status === 'needs_input') {
          this.postMessage({ type: 'error', message: result.message });
          return;
        }

        accumulated = result.content;
        this.state.contents[stage] = accumulated;
        this.state.activeStage = stage;

        if (this.state.activeSpec) {
          this.lastWriteTs = Date.now();
          if (stage === 'tasks') {
            const progress = specManager.syncProgressFromMarkdown(this.state.activeSpec, accumulated);
            this.postMessage({ type: 'progressUpdated', progress });
          }
        }

        this.postMessage({ type: 'streamDone', stage, content: accumulated });
      } catch (err) {
        this.state.generating = false;
        this.state.cancelToken = null;
        const message = err instanceof Error ? err.message : String(err);
        this.postMessage({ type: 'error', message });
      }
      return;
    }

    await this.ai.streamCompletion(
      systemPrompt,
      finalUserContent,
      (chunk) => {
        accumulated += chunk;
        this.postMessage({ type: 'streamChunk', stage, chunk });
      },
      () => {
        this.state.generating = false;
        this.state.cancelToken = null;
        this.state.contents[stage] = accumulated;
        this.state.activeStage = stage;

        if (this.state.activeSpec) {
          this.lastWriteTs = Date.now();
          specManager.writeStage(this.state.activeSpec, stage, accumulated);
          // When tasks complete, sync progress tracking
          if (stage === 'tasks') {
            const progress = specManager.syncProgressFromMarkdown(
              this.state.activeSpec,
              accumulated
            );
            this.postMessage({ type: 'progressUpdated', progress });
          }
        }

        this.postMessage({ type: 'streamDone', stage, content: accumulated });
      },
      (error) => {
        this.state.generating = false;
        this.state.cancelToken = null;
        this.postMessage({ type: 'error', message: error });
      },
      cts.token
    );
  }

  // --- Refine ----------------------------------------------------------------

  private async handleRefine(stage: Stage, feedback: string) {
    if (!this.state.activeSpec || !feedback) return;

    const current = this.state.contents[stage];
    if (!current) return;

    // Build conversation history string for context
    const history = this.state.chatHistory[stage] || [];
    const historyStr =
      history.length > 0
        ? history.map((e) => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.text}`).join('\n')
        : undefined;

    // Record user message
    if (!this.state.chatHistory[stage]) this.state.chatHistory[stage] = [];
    this.state.chatHistory[stage]!.push({ role: 'user', text: feedback });

    // Notify frontend to show user message in chat log
    this.postMessage({ type: 'chatEntry', role: 'user', text: feedback, stage });

    const userPrompt = buildRefinementPrompt(stage, current, feedback, historyStr);
    await this.streamRefinement(stage, userPrompt);
  }

  private async streamRefinement(stage: Stage, userPrompt: string) {
    if (this.state.generating) {
      this.postMessage({
        type: 'error',
        message: 'Generation already in progress. Please wait or cancel first.',
      });
      return;
    }
    this.state.generating = true;

    const cts = new vscode.CancellationTokenSource();
    this.state.cancelToken = cts;

    this.postMessage({ type: 'streamStart', stage, isRefine: true });

    let accumulated = '';

    if (this.isDelegateMode()) {
      try {
        const result = await this.runDelegateStageOperation(
          stage,
          'refine',
          `Refine ${stage}.md for spec ${this.state.activeSpec ?? ''}`,
          REFINE_SYSTEM,
          userPrompt,
          cts.token
        );

        this.state.generating = false;
        this.state.cancelToken = null;

        if (result.status === 'needs_input') {
          const answer = result.message;
          if (this.state.chatHistory[stage]) {
            this.state.chatHistory[stage]!.push({ role: 'assistant', text: answer });
          }
          this.postMessage({ type: 'inquiryDone', stage, answer });
          return;
        }

        accumulated = result.content;
        if (this.state.chatHistory[stage]) {
          this.state.chatHistory[stage]!.push({
            role: 'assistant',
            text: ' Document updated.',
          });
        }
        this.state.contents[stage] = accumulated;
        if (this.state.activeSpec) {
          this.lastWriteTs = Date.now();
          if (stage === 'tasks') {
            const progress = specManager.syncProgressFromMarkdown(this.state.activeSpec, accumulated);
            this.postMessage({ type: 'progressUpdated', progress });
          }
        }
        this.postMessage({ type: 'streamDone', stage, content: accumulated });
      } catch (err) {
        this.state.generating = false;
        this.state.cancelToken = null;
        const message = err instanceof Error ? err.message : String(err);
        this.postMessage({ type: 'error', message });
      }
      return;
    }

    await this.ai.streamCompletion(
      REFINE_SYSTEM,
      userPrompt,
      (chunk) => {
        accumulated += chunk;
        this.postMessage({ type: 'streamChunk', stage, chunk });
      },
      () => {
        this.state.generating = false;
        this.state.cancelToken = null;

        const isInquiry = accumulated.trimStart().startsWith('<!-- INQUIRY -->');
        if (isInquiry) {
          const answer = accumulated.replace('<!-- INQUIRY -->', '').trim();
          // Record in chat history
          if (this.state.chatHistory[stage]) {
            this.state.chatHistory[stage]!.push({ role: 'assistant', text: answer });
          }
          this.postMessage({ type: 'inquiryDone', stage, answer });
        } else {
          // Record revision note in chat history
          if (this.state.chatHistory[stage]) {
            this.state.chatHistory[stage]!.push({
              role: 'assistant',
              text: ' Document updated.',
            });
          }
          this.state.contents[stage] = accumulated;
          if (this.state.activeSpec) {
            this.lastWriteTs = Date.now();
            specManager.writeStage(this.state.activeSpec, stage, accumulated);
            if (stage === 'tasks') {
              const progress = specManager.syncProgressFromMarkdown(
                this.state.activeSpec,
                accumulated
              );
              this.postMessage({ type: 'progressUpdated', progress });
            }
          }
          this.postMessage({ type: 'streamDone', stage, content: accumulated });
        }
      },
      (error) => {
        this.state.generating = false;
        this.state.cancelToken = null;
        this.postMessage({ type: 'error', message: error });
      },
      cts.token
    );
  }

  // --- Manual save ----------------------------------------------------------

  private handleSaveContent(stage: Stage, content: string) {
    if (!this.state.activeSpec) return;
    this.state.contents[stage] = content;
    this.lastWriteTs = Date.now();
    specManager.writeStage(this.state.activeSpec, stage, content);
    if (stage === 'tasks') {
      const progress = specManager.syncProgressFromMarkdown(this.state.activeSpec, content);
      this.postMessage({ type: 'progressUpdated', progress });
    }
    this.postMessage({ type: 'saved', stage });
  }

  // --- Run tasks -------------------------------------------------------------

  private async handleRunTasks() {
    if (!this.state.activeSpec) return;
    const tasksContent = this.state.contents.tasks;
    if (!tasksContent) {
      this.postMessage({
        type: 'error',
        message: 'No tasks to run. Generate the task list first.',
      });
      return;
    }

    const specsFolder =
      vscode.workspace.getConfiguration('nspec').get<string>('specsFolder') || '.specs';
    const specPath = `${specsFolder}/${this.state.activeSpec}`;
    const progress = specManager.syncProgressFromMarkdown(this.state.activeSpec, tasksContent);
    this.postMessage({ type: 'progressUpdated', progress });

    const allTasks = specManager.parseTaskItems(tasksContent);
    const selectedTasks = allTasks.filter((task) => progress.items[task.id] === 'checked');
    if (selectedTasks.length === 0) {
      this.postMessage({
        type: 'error',
        message:
          'No tasks are selected. Check one or more task items (or use Select All) before running.',
      });
      return;
    }

    const prompt = this.buildRunCheckedPrompt(specPath, selectedTasks);

    const allCommands = new Set(await vscode.commands.getCommands(true));
    const startResult = await this.startCodexSession(
      prompt,
      specsFolder,
      this.state.activeSpec,
      allCommands
    );

    if (!startResult.started) {
      const availableHint =
        startResult.availableCodexCommands.length > 0
          ? ' Available Codex/ChatGPT commands: ' +
            startResult.availableCodexCommands.slice(0, 6).join(', ')
          : '';
      const reason =
        startResult.failureReason === 'no_codex_commands'
          ? 'No Codex/ChatGPT commands are available in this VS Code session. Install/enable the OpenAI extension, then reload the window.'
          : 'Found Codex/ChatGPT commands, but nSpec could not start a Codex session automatically. Open Codex once and retry.';
      const message = reason + availableHint;
      this.postMessage({
        type: 'error',
        message,
      });
      void this.notifyCodexUnavailable(message);
      return;
    }

    vscode.window.showInformationMessage(
      'nSpec: Run checked sent to Codex via ' + startResult.commandId + ' and auto-submitted.'
    );
  }

  private getSpecContextFiles(specsFolder: string, specName: string): string[] {
    const wsRoot = this.getWorkspaceRoot();
    if (!wsRoot) return [];
    const files = ['requirements.md', 'design.md', 'tasks.md'] as const;
    return files
      .map((fileName) => path.resolve(wsRoot, specsFolder, specName, fileName))
      .filter((filePath) => fs.existsSync(filePath));
  }

  private trimForPrompt(text: string, maxChars = 8000): string {
    if (!text) return '';
    const compact = text.trim();
    if (compact.length <= maxChars) return compact;
    return compact.slice(0, maxChars) + '\n\n[...truncated by nSpec for prompt size]';
  }

  private buildRunCheckedPrompt(specPath: string, selectedTasks: Array<{ label: string }>): string {
    const req = this.trimForPrompt(this.state.contents.requirements || '', 6000);
    const des = this.trimForPrompt(this.state.contents.design || '', 6000);
    const tasks = this.trimForPrompt(this.state.contents.tasks || '', 8000);

    return [
      `Read the spec at ${specPath}/ (requirements.md, design.md, tasks.md).`,
      'Implement only the selected tasks listed below, in order.',
      'Skip tasks that are not selected and skip tasks already marked done.',
      'Execute commands and edits directly until the selected tasks are complete.',
      'Do not ask for additional confirmation. Start executing immediately.',
      '',
      'Selected tasks:',
      ...selectedTasks.map((task, index) => `${index + 1}. ${task.label}`),
      '',
      'Context snapshots (same content is also attached when supported):',
      '---',
      '## requirements.md',
      req || '(empty)',
      '---',
      '## design.md',
      des || '(empty)',
      '---',
      '## tasks.md',
      tasks || '(empty)',
      '',
      'When done, report a short summary of files changed and tests run.',
    ].join('\n');
  }

  private getCodexCommandCandidates(allCommands: Set<string>): string[] {
    const preferred = [
      'chatgpt.newCodexPanel',
      'chatgpt.newChat',
      'chatgpt.openSidebar',
      'chatgpt.openCommandMenu',
      'chatgpt.addToThread',
      'chatgpt.addFileToThread',
      'codex.startSession',
      'codex.start',
      'codex.newChat',
      'codex.openChat',
      'codex.chat.start',
      'codex.sendMessage',
      'codex.sendPrompt',
      'codex.runPrompt',
      'codex.execute',
      'codex.executePrompt',
      'codex.chat.send',
      'codex.chat.submit',
    ];

    const availableCodex = Array.from(allCommands)
      .filter(isCodexCommand)
      .sort();

    const heuristic = availableCodex.filter((cmd) =>
      /(start|session|chat|prompt|send|run|execute|submit)/i.test(cmd)
    );

    const ordered = [...preferred.filter((cmd) => allCommands.has(cmd)), ...heuristic];
    return Array.from(new Set(ordered));
  }

  private async tryStartCodexWithCommand(
    commandId: string,
    prompt: string,
    specsFolder: string,
    specName: string
  ): Promise<boolean> {
    const contextFiles = this.getSpecContextFiles(specsFolder, specName);
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
        // Try next shape.
      }
    }

    return false;
  }

  private async startCodexSession(
    prompt: string,
    specsFolder: string,
    specName: string,
    allCommands: Set<string>
  ): Promise<{
    started: boolean;
    commandId: string;
    availableCodexCommands: string[];
    failureReason: 'none' | 'no_codex_commands' | 'invoke_failed';
  }> {
    const availableCodexCommands = Array.from(allCommands)
      .filter(isCodexCommand)
      .sort();

    const candidates = this.getCodexCommandCandidates(allCommands);
    if (candidates.length === 0) {
      return {
        started: false,
        commandId: 'none',
        availableCodexCommands,
        failureReason: 'no_codex_commands',
      };
    }

    for (const commandId of candidates) {
      const ok = await this.tryStartCodexWithCommand(commandId, prompt, specsFolder, specName);
      if (ok) {
        return { started: true, commandId, availableCodexCommands, failureReason: 'none' };
      }
    }

    return {
      started: false,
      commandId: 'none',
      availableCodexCommands,
      failureReason: 'invoke_failed',
    };
  }

  private async notifyCodexUnavailable(message: string): Promise<void> {
    const action = await vscode.window.showErrorMessage(
      `nSpec: ${message}`,
      'Open Extensions',
      'Reload Window'
    );

    if (action === 'Open Extensions') {
      await vscode.commands.executeCommand('workbench.view.extensions');
    } else if (action === 'Reload Window') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  private async handleRunTaskSupervised(taskLabel: string) {
    if (this.isDelegateMode()) {
      this.postMessage({
        type: 'error',
        message:
          'Supervised tool-calling run requires API mode. In delegate mode, use "Run checked" so Codex writes files directly.',
      });
      return;
    }
    if (!this.state.activeSpec) return;
    const req = this.state.contents.requirements || '';
    const des = this.state.contents.design || '';
    const wsContext = specManager.buildWorkspaceContext(this.state.activeSpec);
    const wsRoot = this.getWorkspaceRoot();
    if (!wsRoot) return;

    this.postMessage({ type: 'taskRunStart', taskLabel });

    const cts = new vscode.CancellationTokenSource();
    try {
      const result = await this.taskRunner.runTaskSupervised(
        this.ai,
        taskLabel,
        req,
        des,
        wsContext,
        wsRoot,
        cts.token
      );
      this.postMessage({
        type: 'taskRunComplete',
        taskLabel,
        accepted: result.accepted.length,
        rejected: result.rejected.length,
      });
      if (result.accepted.length > 0) {
        const tasksContent = this.state.contents.tasks;
        if (tasksContent) {
          specManager.syncProgressFromMarkdown(this.state.activeSpec!, tasksContent);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'error', message: `Task run failed: ${msg}` });
    }
  }

  private async handleRunAllTasksSupervised() {
    if (this.isDelegateMode()) {
      this.postMessage({
        type: 'error',
        message:
          'Run all supervised requires API mode. In delegate mode, use "Run checked" to delegate task execution to Codex.',
      });
      return;
    }
    if (!this.state.activeSpec) return;
    const tasksContent = this.state.contents.tasks;
    if (!tasksContent) {
      this.postMessage({
        type: 'error',
        message: 'No tasks to run. Generate the task list first.',
      });
      return;
    }
    const req = this.state.contents.requirements || '';
    const des = this.state.contents.design || '';
    const wsContext = specManager.buildWorkspaceContext(this.state.activeSpec);
    const wsRoot = this.getWorkspaceRoot();
    if (!wsRoot) return;

    this.postMessage({ type: 'supervisedRunStart' });

    const cts = new vscode.CancellationTokenSource();
    try {
      await this.taskRunner.runAllSupervised(
        this.ai,
        tasksContent,
        req,
        des,
        wsContext,
        wsRoot,
        (taskLabel) => {
          this.postMessage({ type: 'taskAutoCompleted', taskLabel });
        },
        cts.token
      );
      const progress = specManager.syncProgressFromMarkdown(this.state.activeSpec!, tasksContent);
      this.postMessage({ type: 'progressUpdated', progress });
      this.postMessage({ type: 'supervisedRunComplete' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: 'error', message: `Supervised run failed: ${msg}` });
    }
  }

  private async handleCheckTask(taskLabel: string) {
    if (!this.state.activeSpec) return;
    const results = specManager.checkTaskCompletion(this.state.activeSpec);
    const match = results.find((r) => r.taskLabel === taskLabel);

    this.postMessage({
      type: 'taskCheckResult',
      taskLabel,
      status:
        match && match.score > 0.7
          ? 'complete'
          : match && match.score > 0.3
            ? 'partial'
            : 'incomplete',
      evidence: match?.evidence ?? [],
      score: match?.score ?? 0,
    });
  }

  private async handleCheckAllTasks() {
    if (!this.state.activeSpec) return;
    const results = specManager.checkTaskCompletion(this.state.activeSpec);
    const completed = results.filter((r) => r.score > 0.7);

    this.postMessage({
      type: 'checkAllResults',
      results: results.map((r) => ({
        taskLabel: r.taskLabel,
        status: r.score > 0.7 ? 'complete' : r.score > 0.3 ? 'partial' : 'incomplete',
        evidence: r.evidence,
        score: r.score,
      })),
      completedCount: completed.length,
      totalCount: results.length,
    });
  }

  private getWorkspaceRoot(): string | null {
    return getWorkspaceRoot();
  }

  // --- Delete spec -----------------------------------------------------------

  private handleDeleteSpec(specName: string) {
    specManager.deleteSpec(specName);
    if (this.state.activeSpec === specName) {
      this.state = {
        activeSpec: null,
        activeStage: 'requirements',
        contents: {},
        generating: false,
        cancelToken: null,
        chatHistory: {},
      };
    }
    this.postMessage({ type: 'specDeleted', specName });
  }

  // --- Rename spec ----------------------------------------------------------

  private handleRenameSpec(oldName: string, newName: string) {
    if (!oldName || !newName) return;
    const newFolder = specManager.toFolderName(newName);
    const success = specManager.renameSpec(oldName, newFolder);
    if (success) {
      if (this.state.activeSpec === oldName) {
        this.state.activeSpec = newFolder;
      }
      this.postMessage({ type: 'specRenamed', oldName, newName: newFolder });
      this.sendInit();
    } else {
      this.postMessage({
        type: 'error',
        message: `Could not rename spec. A spec named "${newFolder}" may already exist.`,
      });
    }
  }

  // --- Cascade from stage ---------------------------------------------------

  private async handleCascadeFromStage(fromStage: string) {
    if (!this.state.activeSpec) return;
    const pipeline: Stage[] = ['requirements', 'design', 'tasks', 'verify'];
    const startIdx = pipeline.indexOf(fromStage as Stage);
    if (startIdx < 0) return;

    for (let i = startIdx; i < pipeline.length; i++) {
      const stage = pipeline[i];
      if (stage === 'requirements') {
        // Can't regenerate requirements without a description - skip
        continue;
      }
      if (stage === 'verify') {
        await this.handleGenerateVerify();
      } else {
        await this.handleGenerate(stage as 'design' | 'tasks');
      }
      // If generation was cancelled or errored, stop the cascade
      if (this.state.generating) break;
    }
  }

  // --- Generate requirements (regenerate) -----------------------------------

  private async handleGenerateRequirements() {
    if (!this.state.activeSpec) return;
    const vibeCtx = specManager.loadVibeContext(this.state.activeSpec);
    let userPrompt = '';
    if (vibeCtx?.extractedDescription) {
      userPrompt = vibeCtx.extractedDescription;
      if (vibeCtx.transcript) {
        userPrompt += `\n\n---\n## Original Conversation Transcript\n${vibeCtx.transcript}`;
      }
    } else {
      // Use existing requirements as the prompt for regeneration
      const existing = this.state.contents.requirements;
      if (!existing) {
        this.postMessage({
          type: 'error',
          message: 'No source material to regenerate requirements. Use the refine button instead.',
        });
        return;
      }
      userPrompt = existing;
    }
    await this.streamGenerate('requirements', userPrompt, this.state.activeSpec);
  }

  // --- HTML ------------------------------------------------------------------

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const templatePath = path.join(this.context.extensionPath, 'media', 'panel.html');
    if (!fs.existsSync(templatePath)) {
      throw new Error('Missing webview template: ' + templatePath);
    }
    const template = fs.readFileSync(templatePath, 'utf-8');

    const replacements: Record<string, string> = {
      __NONCE__: nonce,
      __CSP_SOURCE__: webview.cspSource,
      __PANEL_CSS_URI__: webview
        .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.css'))
        .toString(),
      __PANEL_JS_URI__: webview
        .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.js'))
        .toString(),
    };

    return Object.entries(replacements).reduce(
      (html, [token, value]) => html.split(token).join(value),
      template
    );
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
