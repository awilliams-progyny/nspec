import * as vscode from 'vscode';
import * as specManager from './specManager';
import { LMClient } from './lmClient';
import { parseJiraReference } from './jira';
import {
  VIBE_TO_SPEC_SYSTEM,
  buildVibeToSpecPrompt,
  buildSystemPrompt,
  buildRefinementPrompt,
  REFINE_SYSTEM,
} from './prompts';
import type { PromptContext } from './prompts';

// ── Registration ─────────────────────────────────────────────────────────────

export function registerChatParticipant(context: vscode.ExtensionContext): void {
  // Some hosts (or older VS Code builds) may not expose chat APIs.
  // Skip chat registration so core commands still activate.
  const chatApi = (vscode as unknown as { chat?: unknown }).chat as
    | { createChatParticipant?: (id: string, handler: typeof chatHandler) => vscode.Disposable & { iconPath?: vscode.Uri } }
    | undefined;

  if (!chatApi?.createChatParticipant) {
    return;
  }

  const participant = chatApi.createChatParticipant('nspec.chat', chatHandler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
  context.subscriptions.push(participant);
}

// Note: #spec variable resolver requires vscode.chat.registerChatVariableResolver
// which is a proposed API. When VS Code stabilises it (expected ~1.95+), uncomment
// the chatVariables contribution in package.json and add registerSpecVariableResolver here.
// In the meantime, the chat handler detects spec:name patterns and injects context.

// ── Chat handler ─────────────────────────────────────────────────────────────

async function chatHandler(
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  const command = request.command;

  if (command === 'spec') {
    return handleSpecCommand(request, context, stream, token);
  } else if (command === 'status') {
    return handleStatusCommand(request, stream);
  } else if (command === 'refine') {
    return handleRefineCommand(request, context, stream, token);
  } else if (command === 'context') {
    return handleContextCommand(request, stream);
  }

  // Check for spec:name references in the prompt and inject context
  const specRef = request.prompt.match(/(?:#spec:|spec:)([a-z0-9_-]+)/i);
  if (specRef) {
    return handleWithSpecContext(request, context, stream, token, specRef[1]);
  }

  // Default: treat as spec generation
  return handleSpecCommand(request, context, stream, token);
}

// ── /spec command ────────────────────────────────────────────────────────────

async function handleSpecCommand(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    stream.markdown(
      'nSpec requires an open project folder. Use **File -> Open Folder** and run `@nspec /spec <name>` again.'
    );
    return {};
  }

  // Step 1: Build transcript from conversation history
  const transcript = buildTranscriptFromHistory(chatContext.history, request.prompt);

  if (transcript.trim().length < 20) {
    stream.markdown(
      'Not enough conversation context to generate a spec. Have a discussion about a feature first, then use `@nspec /spec <name>`.'
    );
    return {};
  }

  // Step 2: Get spec name from prompt or infer
  const specName = extractSpecName(request.prompt) || 'unnamed-spec';
  const folderName = specManager.toFolderName(specName);

  stream.progress(`Creating spec: ${folderName}...`);

  // Step 3: Create spec folder
  try {
    specManager.createSpecFolder(folderName);
  } catch {
    stream.markdown(`Spec folder \`${folderName}\` may already exist. Proceeding with generation.`);
  }

  // Step 4: Extract description via LLM
  stream.progress('Extracting feature description from conversation...');
  const ai = new LMClient();
  let extractedDescription = '';

  await ai.streamCompletion(
    VIBE_TO_SPEC_SYSTEM,
    buildVibeToSpecPrompt(transcript),
    (chunk) => {
      extractedDescription += chunk;
    },
    () => {},
    (err) => {
      stream.markdown(`\n\n**Error extracting description:** ${err}`);
    },
    token
  );

  if (!extractedDescription || token.isCancellationRequested) {
    stream.markdown('Failed to extract a feature description from the conversation.');
    return {};
  }

  // Step 5: Save vibe context
  specManager.writeVibeContext(folderName, {
    transcript:
      transcript.length > 10000 ? transcript.slice(0, 10000) + '\n\n[...truncated]' : transcript,
    extractedDescription,
    generatedAt: new Date().toISOString(),
  });

  // Step 6: Generate requirements
  stream.progress('Generating requirements...');
  const ctx: PromptContext = {
    title: specName,
    role: specManager.loadRole(folderName) ?? undefined,
    steering: specManager.loadSteering(folderName) ?? undefined,
    extraSections: specManager.loadExtraSections(folderName, 'requirements'),
  };
  const systemPrompt =
    specManager.loadCustomPrompt(folderName, 'requirements') ||
    buildSystemPrompt('requirements', ctx);

  const jiraRefs = extractJiraReferences(`${request.prompt}\n${transcript}`);
  const jiraContextBlock =
    jiraRefs.length > 0
      ? `\n\n## Jira Context\n${jiraRefs
          .map((ref) => `- Jira issue reference: ${ref.raw} (key: ${ref.issueKey})`)
          .join('\n')}\nUse the Jira MCP/context provider to fetch these tickets before drafting requirements.`
      : '';

  const userPrompt = `${extractedDescription}\n\n---\n## Original Conversation Transcript\n${transcript}${jiraContextBlock}`;
  let requirements = '';

  await ai.streamCompletion(
    systemPrompt,
    userPrompt,
    (chunk) => {
      requirements += chunk;
      stream.markdown(chunk);
    },
    () => {},
    (err) => {
      stream.markdown(`\n\n**Error generating requirements:** ${err}`);
    },
    token
  );

  if (requirements) {
    specManager.writeStage(folderName, 'requirements', requirements);
    stream.markdown(
      `\n\n---\nSpec **${folderName}** created. Requirements saved to \`.specs/${folderName}/requirements.md\`.`
    );
    stream.markdown(
      `\nTo generate the full pipeline, run: \`node bin/nspec.mjs cascade ${folderName}\``
    );
  }

  return { metadata: { command: 'spec', specName: folderName } };
}

// ── /status command ──────────────────────────────────────────────────────────

async function handleStatusCommand(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream
): Promise<vscode.ChatResult> {
  const specName = request.prompt.trim();
  const specs = specManager.listSpecs();

  if (specs.length === 0) {
    stream.markdown(
      'No specs found. Create one with `@nspec /spec <name>` or `node bin/nspec.mjs init <name>`.'
    );
    return {};
  }

  if (specName) {
    // Detail view for a specific spec
    const spec = specs.find(
      (s) => s.name === specName || s.name === specManager.toFolderName(specName)
    );
    if (!spec) {
      stream.markdown(
        `Spec **${specName}** not found. Available specs: ${specs.map((s) => `\`${s.name}\``).join(', ')}`
      );
      return {};
    }

    stream.markdown(`## Spec: ${spec.name}\n\n`);
    const stages = ['requirements', 'design', 'tasks', 'verify'] as const;
    for (const stage of stages) {
      const content = specManager.readStage(spec.name, stage);
      const icon = content ? 'O' : '-';
      stream.markdown(`${icon} **${stage}**\n`);
    }

    const progress = specManager.readTaskProgress(spec.name);
    if (progress) {
      const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
      stream.markdown(`\nTasks: ${progress.done}/${progress.total} (${pct}%)\n`);
    }

    const verify = specManager.readStage(spec.name, 'verify');
    if (verify) {
      const scoreMatch = verify.match(/(?:Health\s*Score|Score)\s*[:_-]?\s*(\d+)\s*(?:\/\s*100)?/i);
      if (scoreMatch) {
        stream.markdown(`\nHealth Score: **${scoreMatch[1]}/100**\n`);
      }
    }

    return {};
  }

  // List all specs
  stream.markdown('## nSpec Specs\n\n');
  for (const spec of specs) {
    const stages = ['requirements', 'design', 'tasks', 'verify'] as const;
    const dots = stages.map((s) => (specManager.readStage(spec.name, s) ? 'O' : '-')).join('');
    stream.markdown(`- **${spec.name}** \`[${dots}]\`\n`);
  }

  return {};
}

// ── /refine command ──────────────────────────────────────────────────────────

async function handleRefineCommand(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  const parts = request.prompt.trim().split(/\s+/);
  const specName = parts[0];
  const stage = parts[1] as 'requirements' | 'design' | 'tasks' | 'verify' | undefined;

  if (!specName || !stage || !['requirements', 'design', 'tasks', 'verify'].includes(stage)) {
    stream.markdown(
      'Usage: `@nspec /refine <spec-name> <stage>`\n\nExample: `@nspec /refine auth-feature requirements`'
    );
    return {};
  }

  const folderName = specManager.toFolderName(specName);
  const existingContent = specManager.readStage(folderName, stage);
  if (!existingContent) {
    stream.markdown(`Stage **${stage}** not found for spec **${folderName}**. Generate it first.`);
    return {};
  }

  // Extract feedback from conversation context
  const transcript = buildTranscriptFromHistory(chatContext.history, request.prompt);
  const feedback =
    parts.slice(2).join(' ') || `Based on this conversation, refine the ${stage}:\n${transcript}`;

  stream.progress(`Refining ${stage} for ${folderName}...`);

  const ai = new LMClient();
  const systemPrompt = REFINE_SYSTEM;
  const userPrompt = buildRefinementPrompt(stage, existingContent, feedback);

  let refined = '';
  await ai.streamCompletion(
    systemPrompt,
    userPrompt,
    (chunk) => {
      refined += chunk;
      stream.markdown(chunk);
    },
    () => {},
    (err) => {
      stream.markdown(`\n\n**Error:** ${err}`);
    },
    token
  );

  if (refined) {
    specManager.writeStage(folderName, stage, refined);
    stream.markdown(`\n\n---\nStage **${stage}** updated for **${folderName}**.`);
  }

  return { metadata: { command: 'refine', specName: folderName, stage } };
}

// ── /context command ─────────────────────────────────────────────────────────

async function handleContextCommand(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream
): Promise<vscode.ChatResult> {
  const specName = request.prompt.trim();
  if (!specName) {
    stream.markdown(
      'Usage: `@nspec /context <spec-name>`\n\nThis injects the full spec (requirements + design + tasks) as context.'
    );
    return {};
  }

  const folderName = specManager.toFolderName(specName);
  const context = buildSpecContext(folderName);
  if (!context) {
    stream.markdown(`Spec **${specName}** not found or has no content.`);
    return {};
  }

  stream.markdown(`## Spec Context: ${folderName}\n\n${context}`);
  return { metadata: { command: 'context', specName: folderName } };
}

// ── spec:name context injection ──────────────────────────────────────────────

async function handleWithSpecContext(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  refName: string
): Promise<vscode.ChatResult> {
  const folderName = specManager.toFolderName(refName);
  const specContext = buildSpecContext(folderName);

  if (!specContext) {
    stream.markdown(
      `Could not find spec **${refName}**. Available specs: ${specManager
        .listSpecs()
        .map((s) => `\`${s.name}\``)
        .join(', ')}`
    );
    return {};
  }

  // Build an augmented prompt with spec context prepended
  const ai = new LMClient();
  const systemPrompt = `You are a helpful coding assistant. The user has referenced a specification. Use it as context to help them.\n\n## Spec: ${folderName}\n\n${specContext}`;
  const userPrompt = request.prompt.replace(/(?:#spec:|spec:)[a-z0-9_-]+/i, '').trim();

  await ai.streamCompletion(
    systemPrompt,
    userPrompt || 'Summarize this spec and suggest next steps.',
    (chunk) => {
      stream.markdown(chunk);
    },
    () => {},
    (err) => {
      stream.markdown(`\n\n**Error:** ${err}`);
    },
    token
  );

  return { metadata: { command: 'with-context', specName: folderName } };
}

function buildSpecContext(folderName: string): string | null {
  const stages = ['requirements', 'design', 'tasks'] as const;
  const parts: string[] = [];
  for (const stage of stages) {
    const content = specManager.readStage(folderName, stage);
    if (content) {
      parts.push(`### ${stage.charAt(0).toUpperCase() + stage.slice(1)}\n\n${content}`);
    }
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildTranscriptFromHistory(
  history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[],
  currentPrompt: string
): string {
  const lines: string[] = [];

  for (const turn of history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      lines.push(`User: ${turn.prompt}`);
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .filter(
          (part): part is vscode.ChatResponseMarkdownPart =>
            part instanceof vscode.ChatResponseMarkdownPart
        )
        .map((part) => part.value.value)
        .join('');
      if (text) {
        lines.push(`Assistant: ${text}`);
      }
    }
  }

  // Add current prompt
  if (currentPrompt.trim()) {
    lines.push(`User: ${currentPrompt}`);
  }

  return lines.join('\n\n');
}

function extractSpecName(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (!trimmed) return null;

  // Take the first word/token as the spec name
  const firstWord = trimmed.split(/\s+/)[0];
  // Only use it if it looks like a name (not a sentence)
  if (
    firstWord &&
    firstWord.length < 50 &&
    !firstWord.includes('.') &&
    !firstWord.startsWith('--')
  ) {
    return firstWord;
  }

  return null;
}

function extractJiraReferences(text: string): { raw: string; issueKey: string }[] {
  const refs = new Map<string, { raw: string; issueKey: string }>();
  const urlLike = text.match(/https?:\/\/[^\s)]+/gi) ?? [];
  for (const candidate of urlLike) {
    const parsed = parseJiraReference(candidate);
    if (!parsed) continue;
    refs.set(`${parsed.issueKey}:${parsed.raw}`, { raw: parsed.raw, issueKey: parsed.issueKey });
  }

  const keys = text.match(/\b[A-Z][A-Z0-9]+-\d+\b/gi) ?? [];
  for (const key of keys) {
    const parsed = parseJiraReference(key);
    if (!parsed) continue;
    refs.set(`${parsed.issueKey}:${parsed.raw}`, { raw: parsed.raw, issueKey: parsed.issueKey });
  }

  return Array.from(refs.values()).slice(0, 5);
}
