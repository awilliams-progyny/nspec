import * as vscode from 'vscode';

export type StreamChunkCallback = (chunk: string) => void;
export type StreamDoneCallback = () => void;
export type StreamErrorCallback = (error: string) => void;

export type ProviderKind = 'codex-api' | 'vscode-lm';

export interface AvailableModel {
  id: string;
  vendor: string;
  family: string;
  name: string;
  provider: ProviderKind;
}

export interface CodexApiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  apiKeySource: 'setting' | 'NSPEC_API_KEY' | 'OPENAI_API_KEY';
}

export interface CodexModelDiagnostics {
  allModels: AvailableModel[];
  selectorMatches: AvailableModel[];
  markerMatches: AvailableModel[];
  blockedMatches: Array<{ model: AvailableModel; reasons: string[] }>;
  codexCandidates: AvailableModel[];
  selectedModel: AvailableModel | null;
  unavailableReason: 'none' | 'noProviders' | 'copilotOnly' | 'noCodex';
}

const CODEX_SELECTORS: vscode.LanguageModelChatSelector[] = [
  { vendor: 'codex' },
  { vendor: 'openai' },
  { family: 'codex' },
];

function getConfig() {
  return vscode.workspace.getConfiguration('nspec');
}

function readStringSetting(key: string, fallback: string): string {
  return getConfig().get<string>(key, fallback).trim();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function marker(model: { id: string; vendor: string; family: string; name?: string }): string {
  return `${model.id} ${model.vendor} ${model.family} ${model.name ?? ''}`.toLowerCase();
}

function toAvailableModel(
  model: { id: string; vendor: string; family: string; name?: string },
  provider: ProviderKind
): AvailableModel {
  return {
    id: model.id,
    vendor: model.vendor,
    family: model.family,
    name: model.name ?? `${model.vendor}/${model.family}`,
    provider,
  };
}

function dedupeById(models: vscode.LanguageModelChat[]): vscode.LanguageModelChat[] {
  const seen = new Set<string>();
  const deduped: vscode.LanguageModelChat[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    deduped.push(model);
  }
  return deduped;
}

function getBlockedReasons(model: vscode.LanguageModelChat): string[] {
  const m = marker(model);
  const reasons: string[] = [];
  if (m.includes('copilot')) reasons.push('copilot marker');
  if (m.includes('github')) reasons.push('github marker');
  return reasons;
}

function summarizeModelRows(
  models: Array<{ id: string; vendor: string; family: string; name?: string }>
): string {
  if (!models.length) return '(none)';
  return models
    .map((m) => `${m.id} | ${m.vendor} | ${m.family} | ${m.name ?? ''}`.trim())
    .slice(0, 12)
    .join(' ; ');
}

export function summarizeAvailableModels(models: AvailableModel[]): string {
  return summarizeModelRows(models);
}

export function getCodexApiConfig(): CodexApiConfig | null {
  const settingKey = readStringSetting('apiKey', '');
  if (settingKey) {
    return {
      apiKey: settingKey,
      baseUrl: normalizeBaseUrl(readStringSetting('apiBaseUrl', 'https://api.openai.com/v1')),
      model: readStringSetting('apiModel', 'gpt-5.3-codex'),
      apiKeySource: 'setting',
    };
  }

  const envNspec = process.env.NSPEC_API_KEY?.trim();
  if (envNspec) {
    return {
      apiKey: envNspec,
      baseUrl: normalizeBaseUrl(readStringSetting('apiBaseUrl', 'https://api.openai.com/v1')),
      model: readStringSetting('apiModel', 'gpt-5.3-codex'),
      apiKeySource: 'NSPEC_API_KEY',
    };
  }

  const envOpenAI = process.env.OPENAI_API_KEY?.trim();
  if (envOpenAI) {
    return {
      apiKey: envOpenAI,
      baseUrl: normalizeBaseUrl(readStringSetting('apiBaseUrl', 'https://api.openai.com/v1')),
      model: readStringSetting('apiModel', 'gpt-5.3-codex'),
      apiKeySource: 'OPENAI_API_KEY',
    };
  }

  return null;
}

export function getCodexApiConfigOrThrow(): CodexApiConfig {
  const config = getCodexApiConfig();
  if (config) return config;
  throw new Error(
    'Codex API key is not configured. Set nSpec setting `nspec.apiKey` or environment variable `NSPEC_API_KEY`/`OPENAI_API_KEY`.'
  );
}

async function selectBySelector(
  selector: vscode.LanguageModelChatSelector
): Promise<vscode.LanguageModelChat[]> {
  try {
    return await vscode.lm.selectChatModels(selector);
  } catch {
    return [];
  }
}

export async function getCodexModelDiagnostics(): Promise<CodexModelDiagnostics> {
  let allModels: vscode.LanguageModelChat[] = [];
  try {
    allModels = await vscode.lm.selectChatModels();
  } catch {
    allModels = [];
  }

  const selectorMatches = dedupeById(
    (await Promise.all(CODEX_SELECTORS.map((selector) => selectBySelector(selector)))).flat()
  );
  const markerMatches = dedupeById(allModels.filter((model) => marker(model).includes('codex')));

  const rawCandidates = selectorMatches.length > 0 ? selectorMatches : markerMatches;
  const blockedMatches = rawCandidates
    .map((model) => {
      const reasons = getBlockedReasons(model);
      return reasons.length ? { model, reasons } : null;
    })
    .filter(
      (entry): entry is { model: vscode.LanguageModelChat; reasons: string[] } => entry !== null
    );

  const codexCandidates = dedupeById(
    rawCandidates.filter((model) => getBlockedReasons(model).length === 0)
  );
  const selectedModel = codexCandidates[0] ?? null;

  const unavailableReason: CodexModelDiagnostics['unavailableReason'] = selectedModel
    ? 'none'
    : allModels.length === 0
      ? 'noProviders'
      : allModels.every((m) => getBlockedReasons(m).length > 0)
        ? 'copilotOnly'
        : 'noCodex';

  return {
    allModels: allModels.map((m) => toAvailableModel(m, 'vscode-lm')),
    selectorMatches: selectorMatches.map((m) => toAvailableModel(m, 'vscode-lm')),
    markerMatches: markerMatches.map((m) => toAvailableModel(m, 'vscode-lm')),
    blockedMatches: blockedMatches.map((entry) => ({
      model: toAvailableModel(entry.model, 'vscode-lm'),
      reasons: entry.reasons,
    })),
    codexCandidates: codexCandidates.map((m) => toAvailableModel(m, 'vscode-lm')),
    selectedModel: selectedModel ? toAvailableModel(selectedModel, 'vscode-lm') : null,
    unavailableReason,
  };
}

// ── Tool-calling types ────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export interface ToolCall {
  name: string;
  arguments: Record<string, string>;
}

export interface ProposedChange {
  type: 'writeFile' | 'editFile' | 'runCommand';
  path?: string;
  content?: string;
  oldText?: string;
  newText?: string;
  command?: string;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string };
    message?: {
      content?: string;
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

function buildCodexApiError(status: number, bodyText: string, model: string): Error {
  const detail = bodyText.slice(0, 500);
  const lower = bodyText.toLowerCase();
  let errorCode = '';
  let errorMessage = '';
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: string; message?: string } };
    errorCode = parsed.error?.code ?? '';
    errorMessage = parsed.error?.message ?? '';
  } catch {
    // keep fallback behavior for non-JSON responses
  }

  if (status === 404 && (lower.includes('model_not_found') || lower.includes('does not exist'))) {
    return new Error(
      `Codex API model '${model}' was not found or not accessible. ` +
        "Set 'nspec.apiModel' to a current Codex model (for example 'gpt-5.3-codex' or 'gpt-5.1-codex-mini'). " +
        `Raw error: ${detail}`
    );
  }

  if (
    status === 429 &&
    (errorCode === 'insufficient_quota' || lower.includes('insufficient_quota'))
  ) {
    return new Error(
      'Codex API quota exceeded for this API key/project. ' +
        'Check OpenAI billing, project spend limits, and key/project ownership, then retry. ' +
        `Model: ${model}. API message: ${errorMessage || detail}`
    );
  }

  if (status === 429) {
    return new Error(
      'Codex API rate limit reached. Wait and retry, or lower request volume. ' +
        `Model: ${model}. API message: ${errorMessage || detail}`
    );
  }

  return new Error(`Codex API error ${status}: ${detail}`);
}

async function streamChatCompletions(
  cfg: CodexApiConfig,
  systemPrompt: string,
  userPrompt: string,
  onChunk: StreamChunkCallback,
  token: vscode.CancellationToken
): Promise<void> {
  const ac = new AbortController();
  if (token.isCancellationRequested) ac.abort();
  const cancelSub = token.onCancellationRequested(() => ac.abort());

  try {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: ac.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw buildCodexApiError(response.status, text, cfg.model);
    }

    if (!response.body) {
      const json = (await response.json()) as ChatCompletionChunk;
      const content = json.choices?.[0]?.message?.content;
      if (content) onChunk(content);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const event of events) {
        const line = event
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith('data:'));
        if (!line) continue;

        const payload = line.replace(/^data:\s*/, '');
        if (!payload || payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload) as ChatCompletionChunk;
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) onChunk(delta);
        } catch {
          // ignore non-json heartbeat chunks
        }
      }

      if (token.isCancellationRequested) break;
    }
  } finally {
    cancelSub.dispose();
  }
}

function toolCallsToChanges(toolCalls: ToolCall[]): ProposedChange[] {
  return toolCalls.map((tc) => {
    switch (tc.name) {
      case 'writeFile':
        return {
          type: 'writeFile' as const,
          path: tc.arguments.path,
          content: tc.arguments.content,
        };
      case 'editFile':
        return {
          type: 'editFile' as const,
          path: tc.arguments.path,
          oldText: tc.arguments.oldText,
          newText: tc.arguments.newText,
        };
      case 'runCommand':
        return { type: 'runCommand' as const, command: tc.arguments.command };
      default:
        return {
          type: 'writeFile' as const,
          path: tc.arguments.path || 'unknown',
          content: tc.arguments.content || '',
        };
    }
  });
}

async function callCodexWithTools(
  cfg: CodexApiConfig,
  systemPrompt: string,
  userPrompt: string,
  tools: ToolDefinition[],
  token: vscode.CancellationToken
): Promise<ProposedChange[]> {
  const ac = new AbortController();
  if (token.isCancellationRequested) ac.abort();
  const cancelSub = token.onCancellationRequested(() => ac.abort());

  try {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        tools: tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        })),
        tool_choice: 'auto',
      }),
      signal: ac.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw buildCodexApiError(response.status, text, cfg.model);
    }

    const json = (await response.json()) as ChatCompletionChunk;
    const rawCalls = json.choices?.[0]?.message?.tool_calls ?? [];

    const calls: ToolCall[] = rawCalls
      .map((tc) => {
        const name = tc.function?.name;
        const args = tc.function?.arguments;
        if (!name || !args) return null;
        try {
          return { name, arguments: JSON.parse(args) as Record<string, string> };
        } catch {
          return null;
        }
      })
      .filter((x): x is ToolCall => x !== null);

    return toolCallsToChanges(calls);
  } finally {
    cancelSub.dispose();
  }
}

// ── Public client ─────────────────────────────────────────────────────────

export class LMClient {
  async getAvailableModels(): Promise<AvailableModel[]> {
    const config = getCodexApiConfig();
    if (!config) return [];
    return [
      {
        id: config.model,
        vendor: 'openai',
        family: 'codex',
        name: config.model,
        provider: 'codex-api',
      },
    ];
  }

  async hasAnyModel(): Promise<boolean> {
    return (await this.getAvailableModels()).length > 0;
  }

  async streamCompletion(
    systemPrompt: string,
    userPrompt: string,
    onChunk: StreamChunkCallback,
    onDone: StreamDoneCallback,
    onError: StreamErrorCallback,
    token?: vscode.CancellationToken
  ): Promise<void> {
    const cts = token ? null : new vscode.CancellationTokenSource();
    const cancelToken = token ?? cts!.token;

    try {
      const cfg = getCodexApiConfigOrThrow();
      await streamChatCompletions(cfg, systemPrompt, userPrompt, onChunk, cancelToken);

      if (cancelToken.isCancellationRequested) {
        onError('Generation cancelled.');
        return;
      }

      onDone();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onError(cancelToken.isCancellationRequested ? 'Generation cancelled.' : msg);
    } finally {
      cts?.dispose();
    }
  }

  async sendRequestWithTools(
    systemPrompt: string,
    userPrompt: string,
    tools: ToolDefinition[],
    token?: vscode.CancellationToken
  ): Promise<ProposedChange[]> {
    const cts = token ? null : new vscode.CancellationTokenSource();
    const cancelToken = token ?? cts!.token;

    try {
      const cfg = getCodexApiConfigOrThrow();
      return await callCodexWithTools(cfg, systemPrompt, userPrompt, tools, cancelToken);
    } finally {
      cts?.dispose();
    }
  }
}
