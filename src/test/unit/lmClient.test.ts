/**
 * Unit tests for LMClient provider selection and routing logic.
 * Run: npm run test
 *
 * These tests mock `vscode` and `fetch` to verify that streamCompletion
 * routes to the correct backend without making real HTTP requests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock vscode before importing LMClient ────────────────────────────────────
// vi.hoisted ensures these are available inside the vi.mock factory,
// which vitest hoists to the top of the module before any imports run.

const { mockSelectChatModels, mockGet } = vi.hoisted(() => ({
  mockSelectChatModels: vi.fn(),
  mockGet: vi.fn(),
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: mockGet }),
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
  LanguageModelChatMessage: {
    Assistant: (text: string) => ({ role: 'assistant', content: text }),
    User: (text: string) => ({ role: 'user', content: text }),
  },
}));

import { LMClient } from '../../lmClient';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeVscodeLMModel(id = 'copilot-gpt-4') {
  return {
    id,
    vendor: 'GitHub',
    family: 'gpt-4',
    name: 'GPT-4 (Copilot)',
    sendRequest: vi.fn().mockResolvedValue({ text: (async function* () { yield 'hello'; })() }),
  };
}

/** Set up mockGet to simulate an OpenAI direct-API configuration. */
function useOpenAIConfig(model = 'gpt-4o') {
  mockGet.mockImplementation((key: string, def?: unknown) => {
    if (key === 'apiKey') return 'sk-test-openai';
    if (key === 'apiBaseUrl') return 'https://api.openai.com/v1';
    if (key === 'apiModel') return model;
    return def;
  });
}

/** Set up mockGet to simulate an Anthropic direct-API configuration. */
function useAnthropicConfig(model = 'claude-3-5-sonnet-20241022') {
  mockGet.mockImplementation((key: string, def?: unknown) => {
    if (key === 'apiKey') return 'sk-ant-test';
    if (key === 'apiBaseUrl') return 'https://api.anthropic.com/v1';
    if (key === 'apiModel') return model;
    return def;
  });
}

/** Set up mockGet to simulate no API key configured (vscode.lm only). */
function useNoDirectConfig() {
  mockGet.mockImplementation((_key: string, def?: unknown) => def ?? '');
}

// ── Tests: getAvailableModels ────────────────────────────────────────────────

describe('LMClient.getAvailableModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns vscode.lm models when available', async () => {
    useNoDirectConfig();
    mockSelectChatModels.mockResolvedValue([makeVscodeLMModel()]);

    const client = new LMClient();
    const models = await client.getAvailableModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('copilot-gpt-4');
    expect(models[0].provider).toBe('vscode-lm');
  });

  it('returns direct OpenAI model when API key is set', async () => {
    useOpenAIConfig('gpt-4o');
    mockSelectChatModels.mockResolvedValue([]);

    const client = new LMClient();
    const models = await client.getAvailableModels();

    const directModel = models.find((m) => m.provider === 'openai');
    expect(directModel).toBeDefined();
    expect(directModel?.id).toBe('gpt-4o');
    expect(directModel?.name).toContain('API key');
  });

  it('returns direct Anthropic model when Anthropic API key is set', async () => {
    useAnthropicConfig('claude-3-5-sonnet-20241022');
    mockSelectChatModels.mockResolvedValue([]);

    const client = new LMClient();
    const models = await client.getAvailableModels();

    const directModel = models.find((m) => m.provider === 'anthropic');
    expect(directModel).toBeDefined();
    expect(directModel?.id).toBe('claude-3-5-sonnet-20241022');
  });

  it('returns both vscode.lm and direct models when both configured', async () => {
    useOpenAIConfig('gpt-4o');
    mockSelectChatModels.mockResolvedValue([makeVscodeLMModel()]);

    const client = new LMClient();
    const models = await client.getAvailableModels();

    expect(models.some((m) => m.provider === 'vscode-lm')).toBe(true);
    expect(models.some((m) => m.provider === 'openai')).toBe(true);
  });

  it('returns empty array when nothing configured', async () => {
    useNoDirectConfig();
    mockSelectChatModels.mockResolvedValue([]);

    const client = new LMClient();
    const models = await client.getAvailableModels();

    expect(models).toHaveLength(0);
  });

  it('returns empty array when vscode.lm throws', async () => {
    useNoDirectConfig();
    mockSelectChatModels.mockRejectedValue(new Error('not available'));

    const client = new LMClient();
    const models = await client.getAvailableModels();

    expect(models).toHaveLength(0);
  });
});

// ── Tests: hasAnyModel ───────────────────────────────────────────────────────

describe('LMClient.hasAnyModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when vscode.lm models exist', async () => {
    useNoDirectConfig();
    mockSelectChatModels.mockResolvedValue([makeVscodeLMModel()]);

    const client = new LMClient();
    expect(await client.hasAnyModel()).toBe(true);
  });

  it('returns true when direct API key is configured', async () => {
    useOpenAIConfig();
    mockSelectChatModels.mockResolvedValue([]);

    const client = new LMClient();
    expect(await client.hasAnyModel()).toBe(true);
  });

  it('returns false when nothing is configured', async () => {
    useNoDirectConfig();
    mockSelectChatModels.mockResolvedValue([]);

    const client = new LMClient();
    expect(await client.hasAnyModel()).toBe(false);
  });
});

// ── Tests: setSelectedModel / getSelectedModelId ─────────────────────────────

describe('LMClient model selection state', () => {
  it('starts with no selected model', () => {
    const client = new LMClient();
    expect(client.getSelectedModelId()).toBeNull();
  });

  it('stores selected model id', () => {
    const client = new LMClient();
    client.setSelectedModel('gpt-4o');
    expect(client.getSelectedModelId()).toBe('gpt-4o');
  });

  it('allows overriding the selected model', () => {
    const client = new LMClient();
    client.setSelectedModel('gpt-4o');
    client.setSelectedModel('claude-3-5-sonnet');
    expect(client.getSelectedModelId()).toBe('claude-3-5-sonnet');
  });
});

// ── Tests: streamCompletion provider routing ─────────────────────────────────

describe('LMClient.streamCompletion provider routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Replace global fetch with a spy that returns a minimal streaming response
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: null,
        text: async () => '',
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses vscode.lm when no API key and models available', async () => {
    useNoDirectConfig();
    const vsLmModel = makeVscodeLMModel();
    mockSelectChatModels.mockResolvedValue([vsLmModel]);

    const client = new LMClient();
    const onDone = vi.fn();
    const onError = vi.fn();
    const onChunk = vi.fn();

    await client.streamCompletion('sys', 'user', onChunk, onDone, onError);

    expect(vsLmModel.sendRequest).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled();
  });

  it('uses direct OpenAI when API key set and provider is openai', async () => {
    useOpenAIConfig('gpt-4o');
    mockSelectChatModels.mockResolvedValue([]);

    // Provide a minimal SSE stream
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let done = false;
          return {
            read: async () => {
              if (done) return { done: true, value: undefined };
              done = true;
              const text = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
              return { done: false, value: new TextEncoder().encode(text) };
            },
          };
        },
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new LMClient();
    client.setSelectedModel('gpt-4o', 'openai');
    const onDone = vi.fn();
    const onError = vi.fn();
    const onChunk = vi.fn();

    await client.streamCompletion('sys', 'user', onChunk, onDone, onError);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('api.openai.com'),
      expect.any(Object)
    );
  });

  it('uses Anthropic endpoint when API key starts with sk-ant', async () => {
    useAnthropicConfig('claude-3-5-sonnet-20241022');
    mockSelectChatModels.mockResolvedValue([]);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let done = false;
          return {
            read: async () => {
              if (done) return { done: true, value: undefined };
              done = true;
              const text = 'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"hi"}}\n\nevent: message_stop\ndata: {}\n\n';
              return { done: false, value: new TextEncoder().encode(text) };
            },
          };
        },
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new LMClient();
    client.setSelectedModel('claude-3-5-sonnet-20241022', 'anthropic');
    const onDone = vi.fn();
    const onError = vi.fn();
    const onChunk = vi.fn();

    await client.streamCompletion('sys', 'user', onChunk, onDone, onError);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('anthropic.com'),
      expect.any(Object)
    );
  });

  it('calls onError when no provider configured', async () => {
    useNoDirectConfig();
    mockSelectChatModels.mockResolvedValue([]);

    const client = new LMClient();
    const onDone = vi.fn();
    const onError = vi.fn();

    await client.streamCompletion('sys', 'user', vi.fn(), onDone, onError);

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('No AI provider configured'));
    expect(onDone).not.toHaveBeenCalled();
  });
});
