import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LMClient } from './lmClient';
import * as specManager from './specManager';
import type { ToExtensionMessage, FromExtensionMessage } from './webviewMessages';
import { getSpecsRoot, getWorkspaceRoot } from './workspace';
import { startCodexSession } from './codexBridge';
import { isDone, makeStepId, parseNspecMeta, upsertNspecMeta } from './core/nspecMeta';
import { TaskRunner } from './taskRunner';
import {
  REFINE_SYSTEM,
  buildRefinementPrompt,
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

type GenerationProvider = 'lm' | 'codex-ui';

interface PendingGeneration {
  spec_name: string;
  stage: Stage;
  step_id: string;
  kind: 'generate' | 'refine' | 'transform';
  startedAt: number;
  isRefine: boolean;
}

export class SpecPanelProvider {
  private panel: vscode.WebviewPanel | null = null;
  private context: vscode.ExtensionContext;
  private ai: LMClient;
  private taskRunner: TaskRunner;
  private lastWriteTs = 0;
  private pendingGeneration: PendingGeneration | null = null;
  private pendingWarning: string | null = null;
  private pendingWarningStage: Stage | null = null;
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

  private getGenerationProvider(): GenerationProvider {
    const mode = vscode.workspace
      .getConfiguration('nspec')
      .get<string>('generationProvider', 'codex-ui');
    return mode === 'lm' ? 'lm' : 'codex-ui';
  }

  private isCodexUiMode(): boolean {
    return this.getGenerationProvider() === 'codex-ui';
  }

  private getSpecsFolderName(): string {
    return vscode.workspace.getConfiguration('nspec').get<string>('specsFolder') || '.specs';
  }

  private getPanelVersionLabel(): string {
    if (this.context.extensionMode === vscode.ExtensionMode.Development) {
      return 'dev';
    }
    const version = this.context.extension.packageJSON?.version;
    if (typeof version === 'string' && version.trim()) {
      return version.trim();
    }
    return '';
  }

  private toWorkspaceRelativePath(filePath: string): string {
    const wsRoot = this.getWorkspaceRoot();
    if (!wsRoot) return filePath;
    return path.relative(wsRoot, filePath) || filePath;
  }

  private getStageFilePath(specName: string, stage: Stage): string {
    const specsRoot = getSpecsRoot();
    if (!specsRoot) throw new Error('No specs root found. Open a workspace folder first.');
    return path.join(specsRoot, specName, `${stage}.md`);
  }

  private getSpecRootPath(specName: string): string {
    const specsRoot = getSpecsRoot();
    if (!specsRoot) throw new Error('No specs root found. Open a workspace folder first.');
    return path.join(specsRoot, specName);
  }

  private getExistingSpecStageFiles(specName: string): string[] {
    const specRoot = this.getSpecRootPath(specName);
    const candidates = ['requirements.md', 'design.md', 'tasks.md', 'verify.md'].map((name) =>
      path.join(specRoot, name)
    );
    return candidates.filter((p) => fs.existsSync(p));
  }

  private setPendingWarning(message: string | null, stage: Stage | null = null): void {
    const nextStage = stage ?? this.pendingGeneration?.stage ?? this.state.activeStage;
    if (this.pendingWarning === message && this.pendingWarningStage === nextStage) return;
    this.pendingWarning = message;
    this.pendingWarningStage = nextStage;
    if (!message) {
      this.postMessage({ type: 'pendingMetaWarningCleared' });
      return;
    }
    this.postMessage({ type: 'pendingMetaWarning', stage: nextStage, message });
  }

  private persistStageContent(specName: string, stage: Stage, content: string): string {
    this.lastWriteTs = Date.now();
    const result = specManager.writeStageWithResult(specName, stage, content);
    if (this.state.activeSpec === specName) {
      this.state.contents[stage] = result.content;
      if (result.verifyContent) {
        this.state.contents.verify = result.verifyContent;
        this.postMessage({ type: 'verifyRefreshed', content: result.verifyContent });
      }
    }
    return result.content;
  }

  private clearGenerationState(): void {
    this.state.generating = false;
    this.state.cancelToken?.dispose();
    this.state.cancelToken = null;
  }

  private completePendingGeneration(content: string, pending: PendingGeneration): void {
    this.clearGenerationState();
    this.pendingGeneration = null;
    this.setPendingWarning(null);

    if (pending.kind === 'refine' && this.state.chatHistory[pending.stage]) {
      this.state.chatHistory[pending.stage]!.push({
        role: 'assistant',
        text: ' Document updated.',
      });
    }

    const persistedContent = this.persistStageContent(pending.spec_name, pending.stage, content);

    if (pending.spec_name === this.state.activeSpec) {
      this.state.activeStage = pending.stage;
      if (pending.stage === 'tasks') {
        const progress = specManager.syncProgressFromMarkdown(pending.spec_name, persistedContent);
        this.postMessage({ type: 'progressUpdated', progress });
      }
      this.postMessage({ type: 'streamDone', stage: pending.stage, content: persistedContent });
    }
  }

  private checkPendingGenerationFromDisk(): void {
    const pending = this.pendingGeneration;
    if (!pending) return;

    const targetFile = this.getStageFilePath(pending.spec_name, pending.stage);
    if (!fs.existsSync(targetFile)) return;

    const content = fs.readFileSync(targetFile, 'utf-8');
    const parsed = parseNspecMeta(content);
    if (!parsed.hasMeta) {
      this.setPendingWarning(
        `Waiting for Codex update on ${pending.stage}. Missing nspec meta header. Use "Mark stage done" to recover.`,
        pending.stage
      );
      return;
    }

    const metaStage = parsed.meta.stage;
    const metaStep = parsed.meta.step_id;
    if (metaStage !== pending.stage || metaStep !== pending.step_id) {
      this.setPendingWarning(
        `Waiting for Codex update on ${pending.stage}. Expected stage=${pending.stage}, step_id=${pending.step_id}. Use "Mark stage done" to recover.`,
        pending.stage
      );
      return;
    }

    if (!isDone(parsed.meta)) {
      this.setPendingWarning(null);
      return;
    }

    this.completePendingGeneration(content, pending);
  }

  private buildCodexUiInstruction(
    relativeInstructionPath: string,
    relativeTargetPath: string
  ): string {
    return [
      `Open and follow this instruction file exactly: ${relativeInstructionPath}`,
      `Edit this target file in-place: ${relativeTargetPath}`,
      'Do not stop at chat-only output. Apply file edits in the workspace.',
    ].join('\n');
  }

  private writeCodexUiInstructionFile(
    specName: string,
    stage: Stage,
    stepId: string,
    goal: string,
    targetFile: string,
    systemPrompt: string,
    userPrompt: string
  ): { filePath: string; relativePath: string } {
    const specRoot = this.getSpecRootPath(specName);
    const delegateDir = path.join(specRoot, '.nspec', 'codex-ui');
    fs.mkdirSync(delegateDir, { recursive: true });
    const filePath = path.join(delegateDir, `${stepId}.instruction.md`);
    const relativePath = this.toWorkspaceRelativePath(filePath);
    const relativeTargetPath = this.toWorkspaceRelativePath(targetFile);
    const sourceFiles = this.getExistingSpecStageFiles(specName)
      .map((p) => this.toWorkspaceRelativePath(p))
      .filter((p) => p !== relativeTargetPath);

    const content = [
      '# nSpec Codex-UI Instruction',
      '',
      `- goal: ${goal}`,
      `- stage: ${stage}`,
      `- step_id: ${stepId}`,
      `- target_file: ${relativeTargetPath}`,
      '',
      '## Source Files',
      sourceFiles.length > 0 ? sourceFiles.map((f) => `- ${f}`).join('\n') : '- (none)',
      '',
      '## Required Actions',
      '1. Open the target file and keep the existing `<!-- nspec: ... -->` header at top.',
      '2. Preserve header values for `stage` and `step_id`.',
      '3. Set `done: true` when complete.',
      '4. Replace content below the header with the final markdown result.',
      '5. Do not return chat-only output as the final result.',
      '',
      '## SYSTEM PROMPT',
      '```text',
      systemPrompt,
      '```',
      '',
      '## USER INPUT',
      '```text',
      userPrompt,
      '```',
    ].join('\n');

    fs.writeFileSync(filePath, content, 'utf-8');
    return { filePath, relativePath };
  }

  private async startCodexUiStageOperation(
    stage: Stage,
    kind: PendingGeneration['kind'],
    goal: string,
    systemPrompt: string,
    userPrompt: string,
    isRefine: boolean
  ): Promise<void> {
    const specName = this.state.activeSpec;
    if (!specName) throw new Error('No active spec selected.');

    const stepId = makeStepId(stage);
    const targetFile = this.getStageFilePath(specName, stage);
    const relativeTargetPath = this.toWorkspaceRelativePath(targetFile);
    const current = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf-8') : '';
    const parsedCurrent = parseNspecMeta(current);
    const seedBody = parsedCurrent.body.trim() ? parsedCurrent.body : '(waiting for Codex...)';
    const primed = upsertNspecMeta(seedBody, {
      stage,
      step_id: stepId,
      done: 'false',
    });
    this.lastWriteTs = Date.now();
    fs.writeFileSync(targetFile, primed, 'utf-8');
    this.state.contents[stage] = primed;

    const instruction = this.writeCodexUiInstructionFile(
      specName,
      stage,
      stepId,
      goal,
      targetFile,
      systemPrompt,
      userPrompt
    );
    const codexPrompt = this.buildCodexUiInstruction(instruction.relativePath, relativeTargetPath);

    const allCommands = new Set(await vscode.commands.getCommands(true));
    const attachments = [
      instruction.filePath,
      targetFile,
      ...this.getExistingSpecStageFiles(specName).filter((p) => p !== targetFile),
    ];
    const startResult = await startCodexSession(
      codexPrompt,
      this.getSpecsFolderName(),
      specName,
      allCommands,
      {
        extraContextFiles: attachments,
        codexTodo: {
          filePath: instruction.filePath,
          line: 1,
          comment: codexPrompt,
        },
      }
    );

    if (!startResult.started) {
      const availableHint =
        startResult.availableCodexCommands.length > 0
          ? ' Available Codex/ChatGPT commands: ' +
            startResult.availableCodexCommands.slice(0, 8).join(', ')
          : '';
      const reason =
        startResult.failureReason === 'no_codex_commands'
          ? 'No Codex/ChatGPT commands available to run codex-ui provider.'
          : startResult.failureReason === 'no_send_commands'
            ? 'Codex commands were found, but none can submit an instruction from nSpec. Ensure `chatgpt.implementTodo` is available in this VS Code session.'
            : 'Could not auto-start Codex/ChatGPT command.';
      throw new Error(reason + availableHint);
    }

    this.pendingGeneration = {
      spec_name: specName,
      stage,
      step_id: stepId,
      kind,
      startedAt: Date.now(),
      isRefine,
    };
    this.setPendingWarning(null);

    this.postMessage({
      type: 'taskOutput',
      text: `Codex update requested for ${relativeTargetPath} via ${startResult.commandId}. Instruction: ${instruction.relativePath}`,
    });
  }

  // --- Public API ------------------------------------------------------------

  /** Called by the file watcher when .specs/ files change externally. */
  refreshFromDisk() {
    // Skip if the extension itself just wrote (within 1.5s)
    if (Date.now() - this.lastWriteTs < 1500 && !this.pendingGeneration) return;
    if (!this.panel) return;
    this.checkPendingGenerationFromDisk();
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
        `nSpec: Created default prompt files in ${this.state.activeSpec}/_prompts. Edit or delete the stages you want to customize.`
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

    let extractedDescription = '';
    if (!this.isCodexUiMode()) {
      // Step 3: Extract description from transcript via LM provider.
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
    }

    // Step 4: Save vibe context
    specManager.writeVibeContext(folderName, {
      transcript:
        transcript.length > 10000 ? transcript.slice(0, 10000) + '\n\n[...truncated]' : transcript,
      extractedDescription,
      generatedAt: new Date().toISOString(),
    });

    // Step 5: Generate requirements with transcript as extended context.
    const userPrompt = this.isCodexUiMode()
      ? [
          'Generate requirements directly from this conversation transcript.',
          'Extract feature scope, decisions, constraints, and acceptance criteria.',
          'Output a complete requirements.md.',
          '',
          '---',
          '## Original Conversation Transcript',
          transcript,
        ].join('\n')
      : `${extractedDescription}\n\n---\n## Original Conversation Transcript\n${transcript}`;
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
          this.handleCancelGeneration();
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

        case 'copyToClipboard':
          await vscode.env.clipboard.writeText(msg.text || '');
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

        case 'markStageDone':
          this.handleMarkStageDone();
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
      versionLabel: this.getPanelVersionLabel(),
    });

    if (
      this.pendingWarning &&
      this.pendingWarningStage &&
      this.pendingGeneration?.spec_name === this.state.activeSpec
    ) {
      this.postMessage({
        type: 'pendingMetaWarning',
        stage: this.pendingWarningStage,
        message: this.pendingWarning,
      });
    }
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
    if (this.isCodexUiMode()) {
      this.postMessage({
        type: 'clarificationError',
        message:
          'Clarification streaming is unavailable in codex-ui provider. Continue with spec creation and refine after file generation.',
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
      this.state.contents.verify = specManager.readStage(this.state.activeSpec, 'verify') ?? '';
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
      if (this.isCodexUiMode()) {
        this.state.generating = true;
        this.state.cancelToken = null;
        try {
          await this.startCodexUiStageOperation(
            stage,
            'transform',
            `Transform imported document into ${stage}.md`,
            systemPrompt,
            userPrompt,
            false
          );
        } catch (err) {
          this.clearGenerationState();
          throw err;
        }
        this.postMessage({
          type: 'taskOutput',
          text: `Sent import transform for ${stage}.md to codex-ui. Waiting for file completion...`,
        });
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
          const persisted = this.persistStageContent(this.state.activeSpec!, stage, accumulated);
          if (stage === 'tasks') {
            const progress = specManager.syncProgressFromMarkdown(
              this.state.activeSpec!,
              persisted
            );
            this.postMessage({ type: 'progressUpdated', progress });
          }
          const specName = this.state.activeSpec;
          this.postMessage({ type: 'streamDone', stage, content: persisted });
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

    const verifyContent = specManager.refreshVerify(this.state.activeSpec);
    if (!verifyContent) {
      this.postMessage({
        type: 'error',
        message: 'Verification requires Requirements, Design, and Tasks to all be complete.',
      });
      return;
    }

    this.state.contents.verify = verifyContent;
    this.state.activeStage = 'verify';
    this.postMessage({ type: 'verifyRefreshed', content: verifyContent });
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
      `nSpec: Created default prompt files in ${this.state.activeSpec}/_prompts. Edit or delete the stages you want to customize.`
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

    if (this.isCodexUiMode()) {
      try {
        await this.startCodexUiStageOperation(
          stage,
          'generate',
          `Generate ${stage}.md for spec ${specName}`,
          systemPrompt,
          finalUserContent,
          false
        );
        this.state.activeStage = stage;
        this.postMessage({
          type: 'taskOutput',
          text: `Sent ${stage}.md generation to codex-ui. Waiting for file completion...`,
        });
      } catch (err) {
        this.clearGenerationState();
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
          const persisted = this.persistStageContent(this.state.activeSpec, stage, accumulated);
          // When tasks complete, sync progress tracking
          if (stage === 'tasks') {
            const progress = specManager.syncProgressFromMarkdown(this.state.activeSpec, persisted);
            this.postMessage({ type: 'progressUpdated', progress });
          }
          accumulated = persisted;
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

    if (this.isCodexUiMode()) {
      try {
        await this.startCodexUiStageOperation(
          stage,
          'refine',
          `Refine ${stage}.md for spec ${this.state.activeSpec ?? ''}`,
          REFINE_SYSTEM,
          userPrompt,
          true
        );
        this.postMessage({
          type: 'taskOutput',
          text: `Sent ${stage}.md refinement to codex-ui. Waiting for file completion...`,
        });
      } catch (err) {
        this.clearGenerationState();
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
            const persisted = this.persistStageContent(this.state.activeSpec, stage, accumulated);
            if (stage === 'tasks') {
              const progress = specManager.syncProgressFromMarkdown(
                this.state.activeSpec,
                persisted
              );
              this.postMessage({ type: 'progressUpdated', progress });
            }
            accumulated = persisted;
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

  private handleCancelGeneration() {
    this.state.cancelToken?.cancel();
    this.clearGenerationState();
    this.pendingGeneration = null;
    this.setPendingWarning(null);
    this.postMessage({ type: 'error', message: 'Generation cancelled.' });
  }

  private handleMarkStageDone() {
    if (!this.state.activeSpec) return;
    const pending = this.pendingGeneration;
    const stage = pending?.stage ?? this.state.activeStage;
    const stepId = pending?.step_id ?? makeStepId(stage);
    const targetFile = this.getStageFilePath(this.state.activeSpec, stage);
    const current = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf-8') : '';
    const parsed = parseNspecMeta(current);
    const body = parsed.body.trim() ? parsed.body : current;
    const patched = upsertNspecMeta(body, {
      stage,
      step_id: stepId,
      done: 'true',
    });

    if (pending && pending.stage === stage && pending.step_id === stepId) {
      this.completePendingGeneration(patched, pending);
    } else {
      this.lastWriteTs = Date.now();
      const persisted = this.persistStageContent(this.state.activeSpec, stage, patched);
      if (stage === 'tasks') {
        const progress = specManager.syncProgressFromMarkdown(this.state.activeSpec, persisted);
        this.postMessage({ type: 'progressUpdated', progress });
      }
      this.postMessage({ type: 'streamDone', stage, content: persisted });
    }

    this.setPendingWarning(null);
    this.postMessage({ type: 'taskOutput', text: `Marked ${stage}.md done for step ${stepId}.` });
  }

  // --- Manual save ----------------------------------------------------------

  private handleSaveContent(stage: Stage, content: string) {
    if (!this.state.activeSpec) return;
    this.lastWriteTs = Date.now();
    const persisted = this.persistStageContent(this.state.activeSpec, stage, content);
    if (stage === 'tasks') {
      const progress = specManager.syncProgressFromMarkdown(this.state.activeSpec, persisted);
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
    const startResult = await startCodexSession(
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
          : startResult.failureReason === 'no_send_commands'
            ? 'Codex commands are present, but this session does not expose a prompt-submit command (`chatgpt.implementTodo`). Reload VS Code and retry.'
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
    this.postMessage({
      type: 'taskOutput',
      text: 'Run checked was sent to Codex. Refresh verify after task execution if you want an updated summary.',
    });
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
    if (this.isCodexUiMode()) {
      this.postMessage({
        type: 'error',
        message:
          'Supervised tool-calling run requires lm provider. In codex-ui provider, use "Run checked" so Codex writes files directly.',
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
    if (this.isCodexUiMode()) {
      this.postMessage({
        type: 'error',
        message:
          'Run all supervised requires lm provider. In codex-ui provider, use "Run checked" to delegate task execution to Codex.',
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
    if (this.pendingGeneration?.spec_name === specName) {
      this.pendingGeneration = null;
      this.clearGenerationState();
      this.setPendingWarning(null);
    }
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
