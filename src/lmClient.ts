import * as vscode from 'vscode';

export type StreamChunkCallback = (chunk: string) => void;
export type StreamDoneCallback = () => void;
export type StreamErrorCallback = (error: string) => void;

export type ProviderKind = 'vscode-lm' | 'openai' | 'anthropic';

export interface AvailableModel {
  id: string;
  vendor: string;
  family: string;
  name: string;
  provider: ProviderKind;
}

interface DirectConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: ProviderKind;
}

function getDirectConfig(): DirectConfig | null {
  const cfg = vscode.workspace.getConfiguration('nspec');
  const apiKey = cfg.get<string>('apiKey', '').trim();
  if (!apiKey) return null;
  const baseUrl = cfg.get<string>('apiBaseUrl', 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = cfg.get<string>('apiModel', 'gpt-4o');
  // Detect Anthropic by URL or key prefix
  const provider: ProviderKind =
    baseUrl.includes('anthropic') || apiKey.startsWith('sk-ant') ? 'anthropic' : 'openai';
  return { apiKey, baseUrl, model, provider };
}

// ── vscode.lm helpers ──────────────────────────────────────────────────────

async function getVSCodeLMModels(): Promise<AvailableModel[]> {
  try {
    const models = await vscode.lm.selectChatModels();
    return models.map((m: vscode.LanguageModelChat) => ({
      id: m.id,
      vendor: m.vendor,
      family: m.family,
      name: m.name ?? `${m.vendor}/${m.family}`,
      provider: 'vscode-lm' as ProviderKind,
    }));
  } catch {
    return [];
  }
}

async function streamVSCodeLM(
  modelId: string | null,
  systemPrompt: string,
  userPrompt: string,
  onChunk: StreamChunkCallback,
  onDone: StreamDoneCallback,
  onError: StreamErrorCallback,
  token: vscode.CancellationToken
): Promise<void> {
  try {
    let candidates = modelId
      ? await vscode.lm.selectChatModels({ id: modelId })
      : await vscode.lm.selectChatModels();

    if (!candidates || candidates.length === 0) {
      candidates = await vscode.lm.selectChatModels();
    }
    if (!candidates || candidates.length === 0) {
      throw new Error('No vscode.lm models available');
    }

    const model = candidates[0];
    const messages = [
      vscode.LanguageModelChatMessage.Assistant(systemPrompt),
      vscode.LanguageModelChatMessage.User(userPrompt),
    ];
    const response = await model.sendRequest(messages, {}, token);
    for await (const chunk of response.text) {
      if (token.isCancellationRequested) break;
      onChunk(chunk);
    }
    if (token.isCancellationRequested) {
      onError('Generation cancelled.');
    } else {
      onDone();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    onError(token.isCancellationRequested ? 'Generation cancelled.' : msg);
  }
}

// ── Direct API helpers ─────────────────────────────────────────────────────

async function streamOpenAICompat(
  cfg: DirectConfig,
  systemPrompt: string,
  userPrompt: string,
  onChunk: StreamChunkCallback,
  onDone: StreamDoneCallback,
  onError: StreamErrorCallback,
  token: vscode.CancellationToken
): Promise<void> {
  try {
    const body = JSON.stringify({
      model: cfg.model,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    };

    const ac = new AbortController();
    if (token.isCancellationRequested) ac.abort();
    const cancelSub = token.onCancellationRequested(() => ac.abort());

    let response: Response;
    try {
      response = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: ac.signal,
      });
    } catch (fetchErr: unknown) {
      cancelSub.dispose();
      if (token.isCancellationRequested) {
        onError('Generation cancelled.');
        return;
      }
      throw fetchErr;
    }

    if (!response.ok) {
      cancelSub.dispose();
      const text = await response.text();
      throw new Error(`API error ${response.status}: ${text.slice(0, 200)}`);
    }

    if (!response.body) {
      cancelSub.dispose();
      throw new Error('No response body');
    }

    // Read SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (token.isCancellationRequested) break;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          cancelSub.dispose();
          onDone();
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') onChunk(delta);
        } catch {
          /* skip malformed lines */
        }
      }
    }
    cancelSub.dispose();
    if (token.isCancellationRequested) {
      onError('Generation cancelled.');
    } else {
      onDone();
    }
  } catch (err: unknown) {
    onError(
      token.isCancellationRequested
        ? 'Generation cancelled.'
        : err instanceof Error
          ? err.message
          : String(err)
    );
  }
}

async function streamAnthropicDirect(
  cfg: DirectConfig,
  systemPrompt: string,
  userPrompt: string,
  onChunk: StreamChunkCallback,
  onDone: StreamDoneCallback,
  onError: StreamErrorCallback,
  token: vscode.CancellationToken
): Promise<void> {
  try {
    const body = JSON.stringify({
      model: cfg.model || 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      stream: true,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const ac = new AbortController();
    if (token.isCancellationRequested) ac.abort();
    const cancelSub = token.onCancellationRequested(() => ac.abort());

    let response: Response;
    try {
      response = await fetch(`${cfg.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body,
        signal: ac.signal,
      });
    } catch (fetchErr: unknown) {
      cancelSub.dispose();
      if (token.isCancellationRequested) {
        onError('Generation cancelled.');
        return;
      }
      throw fetchErr;
    }

    if (!response.ok) {
      cancelSub.dispose();
      const text = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 200)}`);
    }

    if (!response.body) {
      cancelSub.dispose();
      throw new Error('No response body');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (token.isCancellationRequested) break;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            onChunk(parsed.delta.text);
          }
          if (parsed.type === 'message_stop') {
            cancelSub.dispose();
            onDone();
            return;
          }
        } catch {
          /* skip */
        }
      }
    }
    cancelSub.dispose();
    if (token.isCancellationRequested) {
      onError('Generation cancelled.');
    } else {
      onDone();
    }
  } catch (err: unknown) {
    onError(
      token.isCancellationRequested
        ? 'Generation cancelled.'
        : err instanceof Error
          ? err.message
          : String(err)
    );
  }
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

// ── Public client ──────────────────────────────────────────────────────────

export class LMClient {
  private selectedModelId: string | null = null;
  private selectedProvider: ProviderKind = 'vscode-lm';

  async getAvailableModels(): Promise<AvailableModel[]> {
    const lmModels = await getVSCodeLMModels();
    const direct = getDirectConfig();

    const directModels: AvailableModel[] = direct
      ? [
          {
            id: direct.model,
            vendor: direct.provider === 'anthropic' ? 'Anthropic' : 'OpenAI',
            family: direct.model,
            name: `${direct.model} (API key)`,
            provider: direct.provider,
          },
        ]
      : [];

    return [...lmModels, ...directModels];
  }

  /** Returns true if any model source is available */
  async hasAnyModel(): Promise<boolean> {
    const models = await this.getAvailableModels();
    return models.length > 0;
  }

  setSelectedModel(modelId: string, provider?: ProviderKind) {
    this.selectedModelId = modelId;
    if (provider) this.selectedProvider = provider;
  }

  getSelectedModelId(): string | null {
    return this.selectedModelId;
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
      // If selected model is direct API — skip vscode.lm entirely
      const direct = getDirectConfig();
      if (this.selectedProvider !== 'vscode-lm' && direct) {
        if (direct.provider === 'anthropic') {
          await streamAnthropicDirect(
            direct,
            systemPrompt,
            userPrompt,
            onChunk,
            onDone,
            onError,
            cancelToken
          );
          return;
        }
        await streamOpenAICompat(
          direct,
          systemPrompt,
          userPrompt,
          onChunk,
          onDone,
          onError,
          cancelToken
        );
        return;
      }

      // Try vscode.lm first
      const lmModels = await getVSCodeLMModels();
      if (lmModels.length > 0) {
        await streamVSCodeLM(
          this.selectedModelId,
          systemPrompt,
          userPrompt,
          onChunk,
          onDone,
          onError,
          cancelToken
        );
        return;
      }

      // Fallback to direct API
      if (direct) {
        if (direct.provider === 'anthropic') {
          await streamAnthropicDirect(
            direct,
            systemPrompt,
            userPrompt,
            onChunk,
            onDone,
            onError,
            cancelToken
          );
          return;
        }
        await streamOpenAICompat(
          direct,
          systemPrompt,
          userPrompt,
          onChunk,
          onDone,
          onError,
          cancelToken
        );
        return;
      }

      onError(
        'No AI provider configured. ' +
          'In VS Code: install GitHub Copilot. ' +
          'In Cursor: add an API key in nSpec settings (nspec.apiKey).'
      );
    } finally {
      cts?.dispose();
    }
  }

  /** Send a request with tool definitions and parse tool call responses into ProposedChanges. */
  async sendRequestWithTools(
    systemPrompt: string,
    userPrompt: string,
    tools: ToolDefinition[],
    token?: vscode.CancellationToken
  ): Promise<ProposedChange[]> {
    const direct = getDirectConfig();
    const cts = token ? null : new vscode.CancellationTokenSource();
    const cancelToken = token ?? cts!.token;

    try {
      if (
        (this.selectedProvider !== 'vscode-lm' && direct) ||
        !(await getVSCodeLMModels()).length
      ) {
        if (!direct) throw new Error('No AI provider configured.');
        return direct.provider === 'anthropic'
          ? await callAnthropicWithTools(direct, systemPrompt, userPrompt, tools, cancelToken)
          : await callOpenAIWithTools(direct, systemPrompt, userPrompt, tools, cancelToken);
      }

      return await callVSCodeLMWithTools(
        this.selectedModelId,
        systemPrompt,
        userPrompt,
        tools,
        cancelToken
      );
    } finally {
      cts?.dispose();
    }
  }
}

// ── Tool-calling API helpers ──────────────────────────────────────────────

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

async function callOpenAIWithTools(
  cfg: DirectConfig,
  systemPrompt: string,
  userPrompt: string,
  tools: ToolDefinition[],
  token: vscode.CancellationToken
): Promise<ProposedChange[]> {
  const ac = new AbortController();
  if (token.isCancellationRequested) ac.abort();
  const cancelSub = token.onCancellationRequested(() => ac.abort());
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: 'auto',
      }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as {
      choices?: {
        message?: { tool_calls?: { function: { name: string; arguments: string } }[] };
      }[];
    };
    const rawCalls = json.choices?.[0]?.message?.tool_calls ?? [];
    const toolCalls: ToolCall[] = rawCalls.map(
      (tc: { function: { name: string; arguments: string } }) => ({
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      })
    );
    return toolCallsToChanges(toolCalls);
  } finally {
    cancelSub.dispose();
  }
}

async function callAnthropicWithTools(
  cfg: DirectConfig,
  systemPrompt: string,
  userPrompt: string,
  tools: ToolDefinition[],
  token: vscode.CancellationToken
): Promise<ProposedChange[]> {
  const ac = new AbortController();
  if (token.isCancellationRequested) ac.abort();
  const cancelSub = token.onCancellationRequested(() => ac.abort());
  try {
    const res = await fetch(`${cfg.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model || 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      }),
      signal: ac.signal,
    });
    if (!res.ok)
      throw new Error(`Anthropic API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as {
      content?: { type: string; name?: string; input?: Record<string, string> }[];
    };
    const toolCalls: ToolCall[] = (json.content ?? [])
      .filter((b: { type: string }) => b.type === 'tool_use')
      .map((b: { name?: string; input?: Record<string, string> }) => ({
        name: b.name!,
        arguments: b.input as Record<string, string>,
      }));
    return toolCallsToChanges(toolCalls);
  } finally {
    cancelSub.dispose();
  }
}

async function callVSCodeLMWithTools(
  modelId: string | null,
  systemPrompt: string,
  userPrompt: string,
  tools: ToolDefinition[],
  token: vscode.CancellationToken
): Promise<ProposedChange[]> {
  const toolDefs = tools
    .map((t) => `- ${t.name}(${t.parameters.required.join(', ')}): ${t.description}`)
    .join('\n');
  const augmented = `${systemPrompt}\n\nRespond with a JSON array of tool calls. Each element: {"name":"<tool>","arguments":{<params>}}.\nAvailable tools:\n${toolDefs}\n\nRespond ONLY with the JSON array.`;

  let candidates = modelId
    ? await vscode.lm.selectChatModels({ id: modelId })
    : await vscode.lm.selectChatModels();
  if (!candidates?.length) candidates = await vscode.lm.selectChatModels();
  if (!candidates?.length) throw new Error('No vscode.lm models available');

  const model = candidates[0];
  const messages = [
    vscode.LanguageModelChatMessage.Assistant(augmented),
    vscode.LanguageModelChatMessage.User(userPrompt),
  ];
  const response = await model.sendRequest(messages, {}, token);
  let accumulated = '';
  for await (const chunk of response.text) {
    if (token.isCancellationRequested) break;
    accumulated += chunk;
  }
  const jsonMatch = accumulated.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[0]) as ToolCall[];
    return toolCallsToChanges(parsed);
  } catch {
    return [];
  }
}
