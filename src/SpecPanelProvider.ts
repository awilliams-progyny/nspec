import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LMClient } from './lmClient';
import * as specManager from './specManager';
import type { ToExtensionMessage, FromExtensionMessage } from './webviewMessages';
import { getWorkspaceRoot } from './workspace';
import { TaskRunner } from './taskRunner';
import {
  fetchJiraIssueForSpec,
  jiraIssueToPrompt,
  parseJiraReference,
  type JiraConfig,
} from './jira';
import { getJiraConfigFromRovoMcp } from './rovoMcpCheck';
import {
  buildSystemPrompt,
  REFINE_SYSTEM,
  buildRefinementPrompt,
  buildVerificationPrompt,
  VIBE_TO_SPEC_SYSTEM,
  buildVibeToSpecPrompt,
  CLARIFICATION_SYSTEM,
  buildClarificationUserPrompt,
  buildClarifiedRequirementsUserPrompt,
} from './prompts';
import type { PromptContext } from './prompts';

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

    // Restore saved model preference
    const savedModel = vscode.workspace.getConfiguration('nspec').get<string>('preferredModelId');
    if (savedModel) this.ai.setSelectedModel(savedModel);

    this.taskRunner = new TaskRunner((text) => this.postMessage({ type: 'taskOutput', text }));
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
    if (this.panel) {
      // Always rebuild the webview document so local UI edits show up immediately.
      this.panel.webview.html = this.buildHtml(this.panel.webview);
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    this.createPanel();
  }

  triggerNewSpec() {
    this.show();
    setTimeout(() => this.postMessage({ type: 'triggerNewSpec' }), 400);
  }

  async pickModel() {
    const models = await this.ai.getAvailableModels();
    if (models.length === 0) {
      vscode.window.showWarningMessage(
        'nSpec: No AI model found. Add an API key in Settings -> nSpec (Cursor), or sign in to GitHub Copilot (VS Code).'
      );
      return;
    }

    const items: (vscode.QuickPickItem & { id: string })[] = models.map((m) => ({
      label: m.name,
      description: `${m.vendor}  -  ${m.id}`,
      id: m.id,
    }));

    const picked = (await vscode.window.showQuickPick(items, {
      title: 'nSpec - Select AI Model',
      placeHolder: 'Choose the model to use for spec generation',
    })) as (vscode.QuickPickItem & { id: string }) | undefined;

    if (picked) {
      this.ai.setSelectedModel(picked.id);
      await vscode.workspace.getConfiguration('nspec').update('preferredModelId', picked.id, true);
      vscode.window.showInformationMessage(`nSpec: Using ${picked.label}`);
      this.postMessage({ type: 'modelChanged', modelName: picked.label, modelId: picked.id });
    }
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
          await this.handleCreateSpec(
            msg.specName,
            msg.prompt,
            msg.specType,
            msg.template,
            msg.jiraUrl
          );
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

        case 'selectModel':
          await this.handleSelectModel(msg.modelId);
          break;

        case 'pickModelFromPalette':
          await this.pickModel();
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

        case 'getModels': {
          const models = await this.ai.getAvailableModels();
          this.postMessage({
            type: 'modelsLoaded',
            models,
            selectedModelId: this.ai.getSelectedModelId(),
          });
          break;
        }

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
          this.handleSetRequirementsFormat(msg.format);
          break;

        case 'cancelTaskRun':
          this.taskRunner.cancelRun();
          break;

        case 'startClarification':
          await this.handleStartClarification(
            msg.specName,
            msg.description,
            msg.specType,
            msg.template,
            msg.jiraUrl
          );
          break;

        case 'submitClarification':
          await this.handleSubmitClarification(
            msg.specName,
            msg.description,
            msg.specType,
            msg.qaTranscript,
            msg.template,
            msg.jiraUrl
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

    const models = await this.ai.getAvailableModels();
    const selectedModelId = this.ai.getSelectedModelId();

    const requirementsFormat =
      this.state.activeSpec != null
        ? (specManager.readConfig(this.state.activeSpec)?.requirementsFormat ?? undefined)
        : undefined;

    this.postMessage({
      type: 'init',
      specs,
      models,
      selectedModelId,
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
    template?: string,
    jiraUrl?: string
  ) {
    if (!(await this.ensureWorkspaceOpen())) return;
    let effectivePrompt = prompt?.trim() || '';

    if (jiraUrl?.trim()) {
      const jiraRef = parseJiraReference(jiraUrl.trim());
      if (!jiraRef) {
        vscode.window.showErrorMessage(
          'nSpec: Invalid Jira reference. Use a Jira issue URL or key (e.g. ET-1905).'
        );
        return;
      }
      const workspaceRoot = this.getWorkspaceRoot();
      const configPath = vscode.workspace
        .getConfiguration('nspec')
        .get<string>('rovoMcpConfigPath');
      const jiraFromMcp = getJiraConfigFromRovoMcp(workspaceRoot, configPath);
      if (!jiraFromMcp.source) {
        vscode.window.showErrorMessage(
          'nSpec: Jira import requires Rovo MCP configuration. Set nSpec.rovoMcpConfigPath or provide .cursor/mcp.json / .codex/config.toml with Atlassian credentials.'
        );
        return;
      }
      const jiraConfig: JiraConfig = {
        baseUrl: jiraFromMcp.baseUrl,
        email: jiraFromMcp.email,
        apiToken: jiraFromMcp.apiToken,
      };
      try {
        const issue = await fetchJiraIssueForSpec(jiraRef.raw, jiraConfig);
        const ticketPrompt = jiraIssueToPrompt(issue);
        effectivePrompt = effectivePrompt ? `${ticketPrompt}\n\n${effectivePrompt}` : ticketPrompt;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`nSpec: ${msg}`);
        return;
      }
    }

    if (!specName?.trim()) {
      vscode.window.showWarningMessage('nSpec: Enter a spec name.');
      return;
    }
    if (!effectivePrompt) {
      vscode.window.showWarningMessage(
        'nSpec: Enter a feature description or a Jira issue URL/ID.'
      );
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
    _template: string,
    _jiraUrl?: string
  ) {
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
    template: string,
    _jiraUrl?: string
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

  private handleSetRequirementsFormat(format: 'given-when-then' | 'ears') {
    if (!this.state.activeSpec) return;
    const cfg = specManager.readConfig(this.state.activeSpec);
    if (!cfg) return;
    specManager.writeSpecConfig(this.state.activeSpec, { ...cfg, requirementsFormat: format });
    this.postMessage({ type: 'requirementsFormatChanged', format });
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
    const specConfig = specManager.readConfig(this.state.activeSpec);
    const ctx: PromptContext = {
      title: this.state.activeSpec,
      steering: specManager.loadSteering(this.state.activeSpec) ?? undefined,
      extraSections: specManager.loadExtraSections(this.state.activeSpec, stage),
      lightDesign: stage === 'design' ? specConfig?.lightDesign : undefined,
      requirementsFormat: stage === 'requirements' ? specConfig?.requirementsFormat : undefined,
    };
    const systemPrompt =
      specManager.loadCustomPrompt(this.state.activeSpec, stage) || buildSystemPrompt(stage, ctx);
    const userPrompt = `Convert the following document into the proper ${stage} format for this spec.\n\n---\n\n${content}`;

    let accumulated = '';
    const cts = new vscode.CancellationTokenSource();
    this.postMessage({ type: 'streamStart', stage });
    try {
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

    // Full override from _prompts/ takes precedence
    const customPrompt = specManager.loadCustomPrompt(specName, stage);
    let systemPrompt: string;

    if (customPrompt) {
      systemPrompt = customPrompt.replace(/{title}/g, specTitle);
      this.postMessage({ type: 'usingCustomPrompt', stage });
    } else {
      const specConfig = specManager.readConfig(specName);
      const ctx: PromptContext = {
        title: specTitle,
        role: specManager.loadRole(specName) ?? undefined,
        steering: specManager.loadSteering(specName) ?? undefined,
        extraSections: specManager.loadExtraSections(specName, stage),
        lightDesign: stage === 'design' ? specConfig?.lightDesign : undefined,
        requirementsFormat: stage === 'requirements' ? specConfig?.requirementsFormat : undefined,
      };
      systemPrompt = buildSystemPrompt(stage, ctx);
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
              const progress = specManager.syncProgressFromMarkdown(this.state.activeSpec, accumulated);
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

    const prompt = [
      `Read the spec at ${specPath}/ (requirements.md, design.md, tasks.md).`,
      'Implement only the selected tasks listed below, in order.',
      'Skip tasks that are not selected and skip tasks already marked done.',
      'Execute commands and edits directly until the selected tasks are complete.',
      '',
      'Selected tasks:',
      ...selectedTasks.map((task, index) => `${index + 1}. ${task.label}`),
      '',
      'When done, report a short summary of files changed and tests run.',
    ].join('\n');

    const allCommands = new Set(await vscode.commands.getCommands(true));
    if (!allCommands.has('codex.startSession')) {
      this.postMessage({
        type: 'error',
        message:
          'Codex command not found (`codex.startSession`). Install/enable Codex and try Run checked again.',
      });
      return;
    }

    const started = await this.startLegacyCodexSession(prompt, specsFolder, this.state.activeSpec);
    if (!started) {
      this.postMessage({
        type: 'error',
        message: 'Failed to start Codex session from nSpec. Open Codex and retry Run checked.',
      });
      return;
    }

    vscode.window.showInformationMessage('nSpec: Run checked sent to Codex and auto-submitted.');
  }

  private getSpecContextFiles(specsFolder: string, specName: string): string[] {
    const wsRoot = this.getWorkspaceRoot();
    if (!wsRoot) return [];
    const files = ['requirements.md', 'design.md', 'tasks.md'] as const;
    return files
      .map((fileName) => path.resolve(wsRoot, specsFolder, specName, fileName))
      .filter((filePath) => fs.existsSync(filePath));
  }

  private async startLegacyCodexSession(
    prompt: string,
    specsFolder: string,
    specName: string
  ): Promise<boolean> {
    const contextFiles = this.getSpecContextFiles(specsFolder, specName);
    const contextUris = contextFiles.map((filePath) => vscode.Uri.file(filePath));

    const payloads: unknown[] = [
      { prompt, autoSubmit: true, contextFiles },
      { prompt, autoSubmit: true, contextUris },
      { prompt, autoSubmit: true, files: contextFiles },
      { prompt, autoSubmit: true, files: contextUris },
      { prompt, autoSubmit: true },
      { prompt },
      prompt,
    ];

    for (const payload of payloads) {
      try {
        await vscode.commands.executeCommand('codex.startSession', payload);
        return true;
      } catch {
        // Try the next payload shape.
      }
    }

    return false;
  }

  private async handleRunTaskSupervised(taskLabel: string) {
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

  private async handleSelectModel(modelId: string) {
    this.ai.setSelectedModel(modelId);
    await vscode.workspace.getConfiguration('nspec').update('preferredModelId', modelId, true);
    const models = await this.ai.getAvailableModels();
    const model = models.find((m) => m.id === modelId);
    this.postMessage({ type: 'modelChanged', modelName: model?.name ?? modelId, modelId });
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
