/**
 * Unit tests for LMClient Codex API routing and diagnostics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSelectChatModels, configValues } = vi.hoisted(() => ({
  mockSelectChatModels: vi.fn(),
  configValues: {} as Record<string, string>,
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: string) =>
        Object.prototype.hasOwnProperty.call(configValues, key) ? configValues[key] : fallback,
    }),
  },
  lm: {
    selectChatModels: mockSelectChatModels,
  },
  CancellationTokenSource: class {
    token = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
    };
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  },
}));

import {
  LMClient,
  getCodexApiConfig,
  getCodexApiConfigOrThrow,
  getCodexModelDiagnostics,
} from '../../lmClient';

function setSetting(key: string, value: string) {
  configValues[key] = value;
}

function clearSettings() {
  for (const key of Object.keys(configValues)) delete configValues[key];
}

function makeLMModel(id: string, vendor: string, family: string, name: string) {
  return { id, vendor, family, name };
}

function makeSSEBody(payloads: string[]) {
  let index = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (index >= payloads.length) return { done: true, value: undefined };
        const next = payloads[index++];
        return { done: false, value: new TextEncoder().encode(next) };
      },
    }),
  };
}

describe('Codex API config', () => {
  const prevNspec = process.env.NSPEC_API_KEY;
  const prevOpenAI = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    clearSettings();
    delete process.env.NSPEC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (prevNspec === undefined) delete process.env.NSPEC_API_KEY;
    else process.env.NSPEC_API_KEY = prevNspec;
    if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAI;
  });

  it('uses nspec.apiKey when set', () => {
    setSetting('apiKey', 'sk-setting');
    setSetting('apiModel', 'codex-test');

    const cfg = getCodexApiConfig();
    expect(cfg?.apiKey).toBe('sk-setting');
    expect(cfg?.model).toBe('codex-test');
    expect(cfg?.apiKeySource).toBe('setting');
  });

  it('falls back to NSPEC_API_KEY then OPENAI_API_KEY', () => {
    process.env.NSPEC_API_KEY = 'sk-nspec';
    expect(getCodexApiConfig()?.apiKeySource).toBe('NSPEC_API_KEY');

    delete process.env.NSPEC_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-openai';
    expect(getCodexApiConfig()?.apiKeySource).toBe('OPENAI_API_KEY');
  });

  it('throws a clear error when no api key is configured', () => {
    expect(() => getCodexApiConfigOrThrow()).toThrow('Codex API key is not configured');
  });
});

describe('LMClient availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSettings();
  });

  it('returns one codex-api model when configured', async () => {
    setSetting('apiKey', 'sk-setting');
    setSetting('apiModel', 'gpt-5.3-codex');

    const client = new LMClient();
    const models = await client.getAvailableModels();

    expect(models).toHaveLength(1);
    expect(models[0].provider).toBe('codex-api');
    expect(models[0].id).toBe('gpt-5.3-codex');
    expect(await client.hasAnyModel()).toBe(true);
  });

  it('returns no model when key is not configured', async () => {
    const client = new LMClient();
    expect(await client.hasAnyModel()).toBe(false);
  });
});

describe('LMClient.streamCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSettings();
    setSetting('apiKey', 'sk-setting');
    setSetting('apiModel', 'gpt-5.3-codex');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams chunks from Codex API SSE', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: makeSSEBody([
        'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
      json: async () => ({}),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    const onChunk = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    await new LMClient().streamCompletion('sys', 'user', onChunk, onDone, onError);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/chat/completions'),
      expect.objectContaining({ method: 'POST' })
    );
    expect(onChunk).toHaveBeenCalledWith('hello ');
    expect(onChunk).toHaveBeenCalledWith('world');
    expect(onDone).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('fails fast if api key is missing', async () => {
    clearSettings();
    const onError = vi.fn();

    await new LMClient().streamCompletion('sys', 'user', vi.fn(), vi.fn(), onError);

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('Codex API key is not configured')
    );
  });

  it('surfaces a clear quota error for insufficient_quota', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      body: null,
      json: async () => ({}),
      text: async () =>
        JSON.stringify({
          error: {
            message: 'You exceeded your current quota, please check your plan and billing details.',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const onError = vi.fn();

    await new LMClient().streamCompletion('sys', 'user', vi.fn(), vi.fn(), onError);

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('Codex API quota exceeded for this API key/project')
    );
  });
});

describe('LMClient.sendRequestWithTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSettings();
    setSetting('apiKey', 'sk-setting');
    setSetting('apiModel', 'gpt-5.3-codex');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses tool calls into proposed changes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'writeFile',
                    arguments: JSON.stringify({ path: 'a.txt', content: 'hello' }),
                  },
                },
              ],
            },
          },
        ],
      }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    const changes = await new LMClient().sendRequestWithTools('sys', 'user', [
      {
        name: 'writeFile',
        description: 'Write file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path' },
            content: { type: 'string', description: 'Content' },
          },
          required: ['path', 'content'],
        },
      },
    ]);

    expect(changes).toEqual([{ type: 'writeFile', path: 'a.txt', content: 'hello' }]);
  });
});

describe('getCodexModelDiagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports blocked copilot model with unavailable reason', async () => {
    const copilot = makeLMModel('gpt-5-mini', 'copilot', 'gpt-5-mini', 'GPT-5 mini');
    mockSelectChatModels.mockImplementation((selector?: { vendor?: string; family?: string }) => {
      if (!selector) return Promise.resolve([copilot]);
      return Promise.resolve([]);
    });

    const diagnostics = await getCodexModelDiagnostics();

    expect(diagnostics.allModels).toHaveLength(1);
    expect(diagnostics.unavailableReason).toBe('copilotOnly');
    expect(diagnostics.blockedMatches).toHaveLength(0); // no codex candidates were matched first
  });

  it('reports selected model when openai selector matches', async () => {
    const openai = makeLMModel('gpt-5', 'openai', 'gpt-5', 'GPT-5');
    mockSelectChatModels.mockImplementation((selector?: { vendor?: string; family?: string }) => {
      if (!selector) return Promise.resolve([openai]);
      if (selector.vendor === 'openai') return Promise.resolve([openai]);
      return Promise.resolve([]);
    });

    const diagnostics = await getCodexModelDiagnostics();

    expect(diagnostics.selectedModel?.id).toBe('gpt-5');
    expect(diagnostics.unavailableReason).toBe('none');
  });
});
