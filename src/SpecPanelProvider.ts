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
      retainContextWhenHidden: true,
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

    const prompt = [
      `Read the spec at ${specPath}/ (requirements.md, design.md, tasks.md).`,
      'Implement all unchecked tasks in order, following the requirements and design closely.',
      'Execute commands and edits directly until all unchecked tasks are complete.',
      'When done, report a short summary of files changed and tests run.',
    ].join(' ');

    // Detect which agent is available and open a session.
    const allCommands = new Set(await vscode.commands.getCommands(true));

    if (allCommands.has('codex.startSession')) {
      const started = await this.startLegacyCodexSession(prompt);
      if (started) return;
    }

    if (allCommands.has('chatgpt.newChat') || allCommands.has('chatgpt.newCodexPanel')) {
      const started = await this.startOpenAICodexSession(
        prompt,
        specsFolder,
        this.state.activeSpec,
        allCommands
      );
      if (started) return;
    }

    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage(
      'No Codex agent detected. Task prompt copied to clipboard.'
    );
  }

  private async startLegacyCodexSession(prompt: string): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('codex.startSession', { prompt, autoSubmit: true });
      return true;
    } catch {
      // Continue to fallback payload shapes.
    }
    try {
      await vscode.commands.executeCommand('codex.startSession', { prompt });
      return true;
    } catch {
      try {
        await vscode.commands.executeCommand('codex.startSession', prompt);
        return true;
      } catch {
        return false;
      }
    }
  }

  private async startOpenAICodexSession(
    prompt: string,
    specsFolder: string,
    specName: string,
    allCommands: Set<string>
  ): Promise<boolean> {
    try {
      if (allCommands.has('chatgpt.newChat')) {
        await vscode.commands.executeCommand('chatgpt.newChat');
      } else {
        await vscode.commands.executeCommand('chatgpt.newCodexPanel');
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
      const attachedCount = allCommands.has('chatgpt.addFileToThread')
        ? await this.attachSpecFilesToOpenAICodex(specsFolder, specName)
        : 0;
      const submitState = await this.submitPromptToOpenAICodex(
        prompt,
        allCommands,
        specsFolder,
        specName
      );
      if (submitState !== 'submitted') {
        await vscode.env.clipboard.writeText(prompt);
      }

      const attachmentNote =
        attachedCount > 0
          ? ` and ${attachedCount} spec file${attachedCount === 1 ? '' : 's'} attached`
          : '';
      const submitNote =
        submitState === 'submitted'
          ? '. Run-all command submitted to Codex chat.'
          : submitState === 'prefilled'
            ? '. Run-all command was prefilled in chat input and copied to clipboard.'
            : '. Task prompt copied to clipboard. Paste and submit to run.';
      vscode.window.showInformationMessage(`nSpec: OpenAI Codex chat opened${attachmentNote}${submitNote}`);
      return true;
    } catch {
      return false;
    }
  }

  private async submitPromptToOpenAICodex(
    prompt: string,
    allCommands: Set<string>,
    specsFolder: string,
    specName: string
  ): Promise<'submitted' | 'prefilled' | 'none'> {
    // Preferred: use Codex-native "implement todo" flow, which submits immediately.
    if (allCommands.has('chatgpt.implementTodo')) {
      try {
        const wsRoot = this.getWorkspaceRoot();
        if (wsRoot) {
          const tasksPath = path.resolve(wsRoot, specsFolder, specName, 'tasks.md');
          const fallbackPath = path.resolve(wsRoot, specsFolder, specName, 'requirements.md');
          const filePath = fs.existsSync(tasksPath) ? tasksPath : fallbackPath;
          await vscode.commands.executeCommand('chatgpt.implementTodo', {
            fileName: encodeURIComponent(filePath),
            line: 1,
            comment: prompt,
          });
          return 'submitted';
        }
      } catch {
        // Fall through to text-injection fallback.
      }
    }

    try {
      if (allCommands.has('chatgpt.openSidebar')) {
        await vscode.commands.executeCommand('chatgpt.openSidebar');
      }
      await vscode.commands.executeCommand('type', { text: prompt });
      // We intentionally avoid generic VS Code chat submit/open commands here
      // because they may target Copilot chat instead of Codex chat.
      return 'prefilled';
    } catch {
      return 'none';
    }
  }

  private async attachSpecFilesToOpenAICodex(
    specsFolder: string,
    specName: string
  ): Promise<number> {
    const wsRoot = this.getWorkspaceRoot();
    if (!wsRoot) return 0;

    const files = ['requirements.md', 'design.md', 'tasks.md'] as const;
    let attached = 0;

    for (const fileName of files) {
      const filePath = path.resolve(wsRoot, specsFolder, specName, fileName);
      if (!fs.existsSync(filePath)) continue;
      try {
        await vscode.commands.executeCommand('chatgpt.addFileToThread', vscode.Uri.file(filePath));
        attached += 1;
      } catch {
        // Continue even if one file fails to attach.
      }
    }

    return attached;
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
    const cspSource = webview.cspSource;
    const panelCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.css')
    );
    const panelJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.js')
    );
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource} https://cdn.jsdelivr.net; style-src 'unsafe-inline' ${cspSource} https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src https://fonts.gstatic.com; img-src data:; connect-src https://cdn.jsdelivr.net https://fonts.googleapis.com https://fonts.gstatic.com;">
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>nSpec</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css">
<link rel="stylesheet" href="${panelCssUri}">
</head>
<style>
:root{
  --bg:#1e1e2e;
  --surface:#252535;
  --surface2:#2d2d44;
  --surface3:#353550;
  --border:#3a3a5c;
  --border-focus:#7c6af7;
  --text:#cdd6f4;
  --text-muted:#6e7096;
  --text-dim:#9399b2;
  --accent:#7c6af7;
  --accent-hover:#8f7fff;
  --accent-dim:#7c6af722;
  --green:#a6e3a1;
  --green-dim:#a6e3a122;
  --yellow:#f9e2af;
  --red:#f38ba8;
  --red-dim:#f38ba822;
  --tag-bg:#313149;
  --scrollbar:#3a3a5c;
  --radius:8px;
  --radius-sm:5px;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:13px;line-height:1.6;overflow:hidden;pointer-events:auto;cursor:default}
#app{pointer-events:auto}

/* -- Layout --------------------------------------------- */
#app{display:flex;height:100vh;overflow:hidden}
#sidebar{width:220px;min-width:220px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
#main{flex:1;display:flex;flex-direction:column;overflow:hidden}

/* -- Sidebar -------------------------------------------- */
.sidebar-header{padding:16px 14px 10px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)}
.sidebar-logo{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;color:var(--text)}
.sidebar-logo svg{color:var(--accent)}
.btn-icon{background:none;border:none;color:var(--text-muted);cursor:pointer;padding:4px;border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;transition:color .15s,background .15s}
.btn-icon:hover{color:var(--text);background:var(--surface3)}
.specs-list{flex:1;overflow-y:auto;padding:8px}
.spec-item{display:flex;align-items:center;justify-content:space-between;padding:7px 8px;border-radius:var(--radius-sm);cursor:pointer;gap:6px;transition:background .12s}
.spec-item:hover{background:var(--surface2)}
.spec-item.active{background:var(--accent-dim);border-left:2px solid var(--accent)}
.spec-item-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.spec-item-dots{display:flex;gap:3px;align-items:center}
.stage-dot{width:7px;height:7px;border-radius:50%;background:var(--border)}
.stage-dot.done{background:var(--accent)}
.spec-item-del{opacity:0;background:none;border:none;color:var(--text-muted);cursor:pointer;padding:2px;border-radius:3px;font-size:11px;line-height:1;transition:opacity .1s}
.spec-item:hover .spec-item-del{opacity:1}
.spec-item-del:hover{color:var(--red)}
.sidebar-footer{padding:10px 14px;border-top:1px solid var(--border)}
.btn-new{width:100%;padding:8px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:12.5px;font-weight:500;display:flex;align-items:center;justify-content:center;gap:6px;transition:background .15s}
.btn-new:hover{background:var(--accent-hover)}

/* -- Top bar (breadcrumb) ------------------------------ */
#topbar{background:var(--surface);border-bottom:1px solid var(--border);padding:0 16px;display:flex;align-items:center;justify-content:space-between;height:42px;flex-shrink:0}
.breadcrumb{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-muted)}
.breadcrumb-spec{font-weight:600;color:var(--text);font-size:12.5px}
.bc-sep{color:var(--border)}
.stage-pill{display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:500;color:var(--text-muted);transition:all .15s;border:1px solid transparent}
.stage-pill:hover{color:var(--text);background:var(--surface2)}
.stage-pill.active{color:#fff;background:var(--accent);border-color:var(--accent)}
.stage-pill.done{color:var(--accent);border-color:var(--accent-dim)}
.stage-pill .pill-num{width:18px;height:18px;border-radius:50%;background:rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;font-size:10px;line-height:1}
.stage-pill.done .pill-num{background:var(--accent-dim)}
.stage-pills{display:flex;align-items:center;gap:4px}
.bc-arrow{color:var(--border);font-size:11px}
.topbar-actions{display:flex;align-items:center;gap:8px;max-width:52vw;overflow-x:auto;overflow-y:hidden;padding-bottom:1px}
.topbar-actions::-webkit-scrollbar{height:4px}
.topbar-actions::-webkit-scrollbar-thumb{background:var(--scrollbar);border-radius:4px}
.btn-action{padding:5px 13px;border-radius:var(--radius-sm);font-size:12px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .15s;border:1px solid var(--border);background:var(--surface2);color:var(--text)}
.btn-action:hover{border-color:var(--accent);color:var(--accent)}
.btn-action.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn-action.primary:hover{background:var(--accent-hover)}
.btn-action.run{background:var(--green-dim);border-color:var(--green);color:var(--green)}
.btn-action.run:hover{background:#a6e3a133}
.btn-action:disabled{opacity:.4;cursor:not-allowed}
.btn-action:disabled:hover{border-color:var(--border);color:var(--text)}

/* -- Content area -------------------------------------- */
#content{flex:1;overflow:hidden;display:flex;flex-direction:column}
.stage-view{flex:1;display:none;flex-direction:column;overflow:hidden}
.stage-view.visible{display:flex}

/* Markdown output */
.md-area{flex:1;overflow-y:auto;padding:24px 32px;max-width:860px;width:100%}
.md-area::-webkit-scrollbar{width:6px}
.md-area::-webkit-scrollbar-track{background:transparent}
.md-area::-webkit-scrollbar-thumb{background:var(--scrollbar);border-radius:4px}
.md-rendered h1{font-size:1.5em;font-weight:600;color:var(--text);margin:0 0 16px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.md-rendered h2{font-size:1.15em;font-weight:600;color:var(--text);margin:24px 0 10px}
.md-rendered h3{font-size:1em;font-weight:600;color:var(--text);margin:16px 0 8px}
.md-rendered p{color:var(--text-dim);margin:0 0 10px}
.md-rendered ul,.md-rendered ol{color:var(--text-dim);padding-left:20px;margin:0 0 10px}
.md-rendered li{margin:3px 0}
.md-rendered code:not(pre code){background:var(--surface2);padding:1px 5px;border-radius:3px;font-size:.9em;color:var(--yellow)}
.md-rendered pre{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:14px;overflow-x:auto;margin:10px 0}
.md-rendered pre code{background:none;padding:0;color:inherit;font-size:.88em}
.md-rendered strong{color:var(--text);font-weight:600}
.md-rendered em{color:var(--text-dim)}
.md-rendered blockquote{border-left:3px solid var(--accent);padding:6px 14px;background:var(--accent-dim);border-radius:0 var(--radius-sm) var(--radius-sm) 0;margin:10px 0;color:var(--text-dim)}
.md-rendered table{width:100%;border-collapse:collapse;margin:10px 0}
.md-rendered th{background:var(--surface2);color:var(--text);padding:7px 12px;text-align:left;border:1px solid var(--border);font-weight:500;font-size:.9em}
.md-rendered td{padding:6px 12px;border:1px solid var(--border);color:var(--text-dim);font-size:.9em}
.md-rendered input[type=checkbox]{accent-color:var(--accent);margin-right:6px}
.md-rendered a{color:var(--accent)}
.stream-cursor::after{content:'|';animation:blink .8s step-end infinite;color:var(--accent);font-size:.85em}
.streaming-preview{margin:0;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;white-space:pre-wrap;word-break:break-word;color:var(--text-dim);font-family:'Consolas','Monaco','Courier New',monospace;font-size:12px;line-height:1.5}
.md-rendered .mermaid{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;margin:10px 0;overflow:auto}
@keyframes blink{50%{opacity:0}}
@keyframes spin{to{transform:rotate(360deg)}}

/* Empty / welcome state */
#welcome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:var(--text-muted)}
#welcome.hidden{display:none}
.welcome-logo{width:56px;height:56px;background:var(--accent-dim);border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:26px}
.welcome-title{font-size:18px;font-weight:600;color:var(--text)}
.welcome-sub{font-size:13px;color:var(--text-muted);max-width:340px;text-align:center}
.btn-welcome{padding:9px 20px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;font-weight:500;transition:background .15s}
.btn-welcome:hover{background:var(--accent-hover)}

/* -- Edit mode textarea -------------------------------- */
.edit-textarea{width:100%;min-height:200px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);padding:14px;font-size:13px;font-family:'Consolas','Monaco','Courier New',monospace;line-height:1.6;resize:none;overflow-y:auto;tab-size:2}
.edit-textarea:focus{outline:none;border-color:var(--border-focus)}
.md-area .edit-textarea{display:none}
.md-area.editing .edit-textarea{display:block}
.md-area.editing .md-rendered{display:none}

/* -- Inline refine ------------------------------------- */
.refine-inline{display:none;align-items:center;gap:8px;padding:6px 16px;border-top:1px solid var(--border);background:var(--surface);flex-shrink:0}
.refine-inline.visible{display:flex}
.refine-input{flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);padding:7px 11px;font-size:12.5px;font-family:inherit;resize:none;height:34px;transition:border-color .15s;line-height:1.4}
.refine-input:focus{outline:none;border-color:var(--border-focus)}
.refine-input::placeholder{color:var(--text-muted)}
.btn-refine-send{padding:7px 14px;background:var(--accent);border:none;border-radius:var(--radius-sm);color:#fff;cursor:pointer;font-size:12px;font-weight:500;white-space:nowrap;transition:background .15s}
.btn-refine-send:hover{background:var(--accent-hover)}
.btn-refine-close{background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:2px 6px;border-radius:3px}
.btn-refine-close:hover{color:var(--text);background:var(--surface3)}

/* -- Cascade dropdown ---------------------------------- */
.cascade-dropdown{position:fixed;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 8px 24px rgba(0,0,0,.4);z-index:200;min-width:220px;overflow:hidden}
.cascade-dropdown-item{padding:8px 14px;cursor:pointer;font-size:12.5px;color:var(--text);transition:background .1s}
.cascade-dropdown-item:hover{background:var(--surface2)}
.cascade-dropdown-item .cd-desc{font-size:11px;color:var(--text-muted);margin-top:2px}

/* -- Toast notification -------------------------------- */
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(80px);background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:8px 18px;border-radius:var(--radius);font-size:12.5px;font-weight:500;z-index:300;opacity:0;transition:all .3s ease;pointer-events:none;white-space:nowrap}
.toast.visible{transform:translateX(-50%) translateY(0);opacity:1}

/* -- Sidebar search ------------------------------------ */
.sidebar-search{padding:8px 8px 0}
.sidebar-search-input{width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);padding:5px 8px;font-size:12px;font-family:inherit;transition:border-color .15s}
.sidebar-search-input:focus{outline:none;border-color:var(--border-focus)}
.sidebar-search-input::placeholder{color:var(--text-muted)}
.specs-count{padding:2px 8px;font-size:10px;color:var(--text-muted)}

/* -- Inline rename ------------------------------------- */
.rename-input{background:var(--surface2);border:1px solid var(--border-focus);color:var(--text);border-radius:3px;padding:2px 6px;font-size:12.5px;font-family:inherit;width:100%;outline:none}

/* -- Empty stage CTA ----------------------------------- */
.empty-stage{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:60px 20px;color:var(--text-muted);text-align:center}
.empty-stage-text{font-size:13px}
.btn-empty-cta{padding:8px 18px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:12.5px;font-weight:500;transition:background .15s}
.btn-empty-cta:hover{background:var(--accent-hover)}

/* -- Custom prompts indicator -------------------------- */
.custom-prompts-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);margin-left:4px;vertical-align:middle}

/* -- Modals --------------------------------------------- */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(4px);pointer-events:auto}
.modal-overlay.hidden{display:none}
.modal{background:var(--surface);pointer-events:auto;border:1px solid var(--border);border-radius:12px;padding:24px;width:480px;max-width:calc(100vw - 32px);box-shadow:0 24px 60px rgba(0,0,0,.5)}
.modal-title{font-size:15px;font-weight:600;color:var(--text);margin-bottom:6px}
.modal-sub{font-size:12.5px;color:var(--text-muted);margin-bottom:18px}
.modal-field{margin-bottom:14px}
.modal-label{display:block;font-size:12px;font-weight:500;color:var(--text-dim);margin-bottom:6px}
.modal-input{width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);padding:8px 11px;font-size:13px;font-family:inherit;transition:border-color .15s}
.modal-input:focus{outline:none;border-color:var(--border-focus)}
.modal-input::placeholder{color:var(--text-muted)}
textarea.modal-input{resize:vertical;min-height:90px;line-height:1.5}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:20px}

/* -- Wizard (D1: Guided creation) ---------------------- */
.wizard-modal{width:520px;max-height:calc(100vh - 80px);overflow-y:auto}
.wizard-stepper{display:flex;align-items:center;gap:0;margin-bottom:22px}
.wizard-step-node{display:flex;align-items:center;gap:6px}
.wizard-step-circle{width:24px;height:24px;border-radius:50%;background:var(--surface3);border:1.5px solid var(--border);color:var(--text-muted);font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;transition:all .2s;flex-shrink:0}
.wizard-step-circle.active{background:var(--accent);border-color:var(--accent);color:#fff}
.wizard-step-circle.done{background:var(--accent-dim);border-color:var(--accent);color:var(--accent)}
.wizard-step-label{font-size:11px;color:var(--text-muted);font-weight:500;transition:color .2s;white-space:nowrap}
.wizard-step-label.active{color:var(--text)}
.wizard-step-connector{flex:1;height:1px;background:var(--border);margin:0 8px}
.wizard-step-connector.done{background:var(--accent)}
.wizard-pane{display:none}
.wizard-pane.active{display:block}

/* Clarification area (D2) */
.clarify-loading{font-size:12.5px;color:var(--text-muted);padding:10px 0;display:flex;align-items:center;gap:8px}
.clarify-mc-question{margin-bottom:16px}
.clarify-mc-qlabel{font-size:12.5px;font-weight:500;color:var(--text);margin-bottom:7px;line-height:1.4}
.clarify-mc-options{display:flex;flex-direction:column;gap:4px}
.clarify-mc-opt{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;font-size:12.5px;color:var(--text-dim);transition:all .12s;line-height:1.4}
.clarify-mc-opt:hover{border-color:var(--accent);color:var(--text);background:var(--accent-dim)}
.clarify-mc-opt input[type=radio]{accent-color:var(--accent);margin-top:2px;flex-shrink:0;cursor:pointer}
.clarify-mc-opt.selected{border-color:var(--accent);color:var(--text);background:var(--accent-dim)}
.clarify-mc-custom-input{width:100%;background:var(--surface3);border:none;border-top:1px solid var(--border);color:var(--text);padding:6px 8px;font-size:12px;font-family:inherit;border-radius:0 0 var(--radius-sm) var(--radius-sm);margin-top:4px;display:none}
.clarify-mc-custom-input:focus{outline:none}
.clarify-mc-custom-input::placeholder{color:var(--text-muted)}
.clarify-skip-link{font-size:11.5px;color:var(--text-muted);text-decoration:none;cursor:pointer;transition:color .15s}
.clarify-skip-link:hover{color:var(--text)}
.btn-modal-cancel{padding:7px 16px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);cursor:pointer;font-size:13px;transition:all .15s}
.btn-modal-cancel:hover{border-color:var(--text-muted)}
.btn-modal-ok{padding:7px 16px;background:var(--accent);border:none;color:#fff;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;font-weight:500;transition:background .15s}
.btn-modal-ok:hover{background:var(--accent-hover)}
.btn-modal-ok:disabled{opacity:.45;cursor:not-allowed}
.btn-modal-ok:disabled:hover{background:var(--accent)}

/* -- Task progress bar --------------------------------- */
.progress-bar-wrap{height:3px;background:var(--border);border-radius:2px;overflow:hidden;margin-top:4px}
.progress-bar-fill{height:100%;background:var(--accent);border-radius:2px;transition:width .3s}
.progress-label{font-size:10px;color:var(--text-muted)}
/* -- Verify health score badge ------------------------- */
.health-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:12px;font-size:11.5px;font-weight:600;border:1px solid}
.health-excellent{background:rgba(166,227,161,.12);color:var(--green);border-color:rgba(166,227,161,.3)}
.health-good{background:rgba(124,106,247,.12);color:var(--accent);border-color:rgba(124,106,247,.3)}
.health-fair{background:rgba(249,226,175,.12);color:var(--yellow);border-color:rgba(249,226,175,.3)}
.health-poor{background:var(--red-dim);color:var(--red);border-color:rgba(243,139,168,.3)}
/* -- OpenSpec badge ------------------------------------ */
.openspec-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;background:rgba(124,106,247,.1);border:1px solid rgba(124,106,247,.3);border-radius:10px;font-size:10px;color:var(--accent);cursor:pointer}
.openspec-badge:hover{background:var(--accent-dim)}
/* -- Interactive task checkboxes ----------------------- */
.md-rendered input[type=checkbox]{accent-color:var(--accent);cursor:pointer;width:13px;height:13px}
.task-row{display:flex;align-items:baseline;gap:6px}
.task-row.done label{text-decoration:line-through;color:var(--text-muted)}
/* -- Spec dots with 4 stages -------------------------- */
.spec-item-dots{display:flex;gap:3px;align-items:center}
.stage-dot.verify{background:var(--yellow)}
/* -- Verify stage view specific ----------------------- */
.verify-header{padding:16px 32px 0;display:flex;align-items:center;gap:10px}
/* -- Model selector chip ------------------------------- */
.model-chip{display:flex;align-items:center;gap:6px;padding:4px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:20px;cursor:pointer;font-size:11.5px;color:var(--text-muted);transition:all .15s;white-space:nowrap;max-width:200px;overflow:hidden}
.model-chip:hover{border-color:var(--accent);color:var(--text)}
.model-chip svg{flex-shrink:0;color:var(--accent)}
.model-chip-name{overflow:hidden;text-overflow:ellipsis}
.model-chip-none{color:var(--red);border-color:var(--red-dim)}
.model-chip-none:hover{border-color:var(--red)}
/* -- API key warning ------------------------------------ */
#api-warning{display:none;align-items:center;gap:10px;padding:8px 16px;background:var(--red-dim);border-bottom:1px solid var(--red);font-size:12.5px;color:var(--red)}
#api-warning.visible{display:flex}
.link-btn{background:none;border:none;color:var(--red);text-decoration:underline;cursor:pointer;font-size:12.5px}

/* -- Spinner -------------------------------------------- */
.spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
<body>
<div id="app">

  <!-- -- Sidebar ---------------------------------------- -->
  <div id="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-logo">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        nSpec
      </div>
    </div>
    <div class="sidebar-search">
      <input type="text" class="sidebar-search-input" id="sidebar-search" placeholder="Filter specs...">
    </div>
    <div class="specs-count" id="specs-count"></div>
    <div class="specs-list" id="specs-list"></div>
    <div class="sidebar-footer">
      <button type="button" class="btn-new" id="btn-new-spec">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Spec
      </button>
    </div>
  </div>

  <!-- -- Main ------------------------------------------- -->
  <div id="main">

    <!-- Top bar -->
    <div id="topbar">
      <div class="breadcrumb">
        <span class="breadcrumb-spec" id="bc-spec">-</span>
        <span class="bc-sep">></span>
        <div class="stage-pills" id="stage-pills">
          <div class="stage-pill" data-stage="requirements" id="pill-requirements">
            <span class="pill-num">1</span> Requirements
          </div>
          <span class="bc-arrow">></span>
          <div class="stage-pill" data-stage="design" id="pill-design">
            <span class="pill-num">2</span> Design
          </div>
          <span class="bc-arrow">></span>
          <div class="stage-pill" data-stage="tasks" id="pill-tasks">
            <span class="pill-num">3</span> Task list
          </div>
          <span class="bc-arrow">></span>
          <div class="stage-pill" data-stage="verify" id="pill-verify">
            <span class="pill-num">4</span> Verify
          </div>
        </div>
      </div>
      <div class="topbar-actions" id="topbar-actions"></div>
    </div>

    <!-- No model configured (shown when no AI model is available) -->
    <div id="no-model-card" style="display:none;margin:16px 24px;padding:16px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);font-size:13px;">
      <div style="font-weight:600;color:var(--text);margin-bottom:6px;">No AI model configured</div>
      <div style="color:var(--text-muted);margin-bottom:12px;">In Cursor, set an API key in Settings. In VS Code, install and sign in to GitHub Copilot.</div>
      <button type="button" id="btn-open-settings" class="btn-primary" style="padding:6px 14px;font-size:12px;">Open settings</button>
    </div>

    <!-- Content -->
    <div id="content">
      <!-- Welcome -->
      <div id="welcome">
        <div class="welcome-logo">nS</div>
        <div class="welcome-title">Welcome to nSpec</div>
        <div class="welcome-sub">Create AI-powered specs with Requirements, Design, and Task plans in seconds.</div>
        <button type="button" class="btn-welcome" id="btn-welcome-new">Create your first spec</button>
      </div>

      <!-- Requirements view -->
      <div class="stage-view" id="view-requirements">
        <div class="md-area" id="area-requirements"><div class="md-rendered" id="md-requirements"></div><textarea class="edit-textarea" id="edit-requirements"></textarea></div>
      </div>
      <!-- Design view -->
      <div class="stage-view" id="view-design">
        <div class="md-area" id="area-design"><div class="md-rendered" id="md-design"></div><textarea class="edit-textarea" id="edit-design"></textarea></div>
      </div>
      <!-- Tasks view -->
      <div class="stage-view" id="view-tasks">
        <div id="tasks-progress-header" style="padding:12px 32px 0;display:none">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span class="progress-label" id="progress-label">0 / 0 tasks</span>
            <span id="progress-pct" style="font-size:10px;color:var(--accent);font-weight:600">0%</span>
          </div>
          <div class="progress-bar-wrap"><div class="progress-bar-fill" id="progress-bar" style="width:0%"></div></div>
        </div>
        <div class="md-area" id="area-tasks"><div class="md-rendered" id="md-tasks"></div><textarea class="edit-textarea" id="edit-tasks"></textarea></div>
      </div>
      <!-- Verify view -->
      <div class="stage-view" id="view-verify">
        <div id="verify-score-header" class="verify-header" style="display:none">
          <span id="health-badge" class="health-badge health-good">- / 100</span>
          <span style="font-size:12px;color:var(--text-muted)" id="health-verdict"></span>
        </div>
        <div class="md-area" id="area-verify"><div class="md-rendered" id="md-verify"></div><textarea class="edit-textarea" id="edit-verify"></textarea></div>
      </div>
    </div>

    <!-- Inline refine bar (replaces bottom bar) -->
    <div class="refine-inline" id="refine-inline">
      <input type="text" class="refine-input" id="refine-input" placeholder="Describe the change... (Enter to apply)">
      <button class="btn-refine-send" id="btn-refine-send">Refine</button>
      <button class="btn-refine-close" id="btn-refine-close" title="Close">x</button>
    </div>

  </div>
</div>

<!-- -- New Spec Wizard (D1: Guided creation) ------------ -->
<div class="modal-overlay hidden" id="modal-new">
  <div class="modal wizard-modal">

    <!-- -- Step 1: Describe (type + name + description) -- -->
    <div class="wizard-pane active" id="wizard-pane-1">
      <div class="modal-title">New Spec</div>
      <div class="modal-field">
        <label class="modal-label">Type</label>
        <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:4px;padding:5px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;color:var(--text-dim);transition:all .15s" class="spec-type-opt" data-type="feature">
            <input type="radio" name="spec-type" value="feature" checked style="accent-color:var(--accent)"> Feature
          </label>
          <label style="display:flex;align-items:center;gap:4px;padding:5px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;color:var(--text-dim);transition:all .15s" class="spec-type-opt" data-type="bugfix">
            <input type="radio" name="spec-type" value="bugfix" style="accent-color:var(--accent)"> Bugfix
          </label>
          <label style="display:flex;align-items:center;gap:4px;padding:5px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;color:var(--text-dim);transition:all .15s" class="spec-type-opt" data-type="design-first">
            <input type="radio" name="spec-type" value="design-first" style="accent-color:var(--accent)"> Design First
          </label>
        </div>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="new-spec-name">Name</label>
        <input class="modal-input" id="new-spec-name" type="text" placeholder="e.g. User Authentication">
      </div>
      <div class="modal-field">
        <label class="modal-label" for="new-spec-prompt" id="prompt-label">Description</label>
        <textarea class="modal-input" id="new-spec-prompt" rows="4" placeholder="Describe the feature, its purpose, key behaviors, and any constraints..."></textarea>
      </div>
      <div class="modal-field" id="template-field">
        <label class="modal-label" for="new-spec-template">Template <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
        <select class="modal-input" id="new-spec-template" style="padding:7px 11px">
          <option value="">No template - start blank</option>
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn-modal-cancel" id="btn-new-cancel">Cancel</button>
        <button class="btn-modal-ok" id="btn-wiz-next-1">Generate -></button>
      </div>
    </div>

  </div>
</div>

<!-- -- Confirm delete modal ----------------------------- -->
<div class="modal-overlay hidden" id="modal-delete">
  <div class="modal">
    <div class="modal-title">Delete spec?</div>
    <div class="modal-sub" id="modal-delete-msg">This will permanently delete the spec and all its files.</div>
    <div class="modal-actions">
      <button class="btn-modal-cancel" id="btn-del-cancel">Cancel</button>
      <button class="btn-modal-ok" style="background:var(--red)" id="btn-del-ok">Delete</button>
    </div>
  </div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js"></script>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script src="${panelJsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
