/**
 * Check if Rovo MCP (e.g. atlassian-rovo-mcp) is configured for use with Jira integration.
 * If the user sets nspec.rovoMcpConfigPath (e.g. to config.toml), we parse that file (TOML).
 * Otherwise we fall back to .cursor/mcp.json (workspace then global).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import toml from 'toml';

const ROVO_SERVER_KEYS = ['atlassian-rovo-mcp', 'rovo'];
const MCP_FILENAME = 'mcp.json';
const CURSOR_DIR = '.cursor';
const CODEX_DIR = '.codex';
const CODEX_CONFIG = 'config.toml';
const BASE_URL_ENV_KEYS = [
  'ATLASSIAN_URL',
  'ATLASSIAN_BASE_URL',
  'JIRA_BASE_URL',
  'JIRA_URL',
  'JIRA_HOST',
];
const EMAIL_ENV_KEYS = ['ATLASSIAN_EMAIL', 'JIRA_EMAIL'];
const TOKEN_ENV_KEYS = ['ATLASSIAN_API_TOKEN', 'ATLASSIAN_TOKEN', 'JIRA_API_TOKEN', 'JIRA_TOKEN'];

export interface RovoMcpCheckResult {
  configured: boolean;
  source: 'config.toml' | 'workspace' | 'global' | 'codex-workspace' | 'codex-global' | null;
  path: string | null;
}

export interface JiraConfigFromMcpResult {
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  source: 'config.toml' | 'workspace' | 'global' | 'codex-workspace' | 'codex-global' | null;
  path: string | null;
}

interface ParsedMcpConfig {
  mcpServers?: Record<string, unknown>;
  mcp_servers?: Record<string, unknown>;
  servers?: Record<string, unknown>;
}

interface ResolvedServers {
  source: 'config.toml' | 'workspace' | 'global' | 'codex-workspace' | 'codex-global';
  path: string;
  servers: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getServers(config: ParsedMcpConfig): Record<string, unknown> | null {
  if (isRecord(config.mcpServers)) return config.mcpServers;
  if (isRecord(config.mcp_servers)) return config.mcp_servers;
  if (isRecord(config.servers)) return config.servers;
  return null;
}

function isRovoServerKey(serverKey: string): boolean {
  const lower = serverKey.toLowerCase();
  return (
    ROVO_SERVER_KEYS.includes(lower) || lower.includes('rovo') || lower.includes('atlassian')
  );
}

function hasRovoInServers(servers: Record<string, unknown> | null | undefined): boolean {
  if (!servers) return false;
  return Object.keys(servers).some((k) => isRovoServerKey(k));
}

function resolveConfigPath(configPath: string, workspaceRoot: string | null): string | null {
  if (path.isAbsolute(configPath)) return configPath;
  if (!workspaceRoot) return null;
  return path.join(workspaceRoot, configPath);
}

function readTomlServers(configPath: string, workspaceRoot: string | null): ResolvedServers | null {
  const resolved = resolveConfigPath(configPath, workspaceRoot);
  if (!resolved || !fs.existsSync(resolved)) return null;
  try {
    const raw = fs.readFileSync(resolved, 'utf-8');
    const data = toml.parse(raw) as ParsedMcpConfig;
    const servers = getServers(data);
    if (!servers) return null;
    return { source: 'config.toml', path: resolved, servers };
  } catch {
    return null;
  }
}

function readTomlServersAtPath(
  configPath: string,
  source: 'codex-workspace' | 'codex-global'
): ResolvedServers | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const data = toml.parse(raw) as ParsedMcpConfig;
    const servers = getServers(data);
    if (!servers) return null;
    return { source, path: configPath, servers };
  } catch {
    return null;
  }
}

function readJsonServers(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as ParsedMcpConfig;
    return getServers(data);
  } catch {
    return null;
  }
}

function readMcpJsonServers(workspaceRoot: string | null): ResolvedServers | null {
  const candidates: { path: string; source: 'workspace' | 'global' }[] = [];
  if (workspaceRoot) {
    candidates.push({
      path: path.join(workspaceRoot, CURSOR_DIR, MCP_FILENAME),
      source: 'workspace',
    });
  }
  const homedir = os.homedir();
  if (homedir) {
    candidates.push({ path: path.join(homedir, CURSOR_DIR, MCP_FILENAME), source: 'global' });
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.path)) continue;
    const servers = readJsonServers(candidate.path);
    if (!servers) continue;
    return { source: candidate.source, path: candidate.path, servers };
  }
  return null;
}

function readCodexTomlServers(workspaceRoot: string | null): ResolvedServers | null {
  const candidates: { path: string; source: 'codex-workspace' | 'codex-global' }[] = [];
  if (workspaceRoot) {
    candidates.push({
      path: path.join(workspaceRoot, CODEX_DIR, CODEX_CONFIG),
      source: 'codex-workspace',
    });
  }
  const homedir = os.homedir();
  if (homedir) {
    candidates.push({
      path: path.join(homedir, CODEX_DIR, CODEX_CONFIG),
      source: 'codex-global',
    });
  }

  for (const candidate of candidates) {
    const parsed = readTomlServersAtPath(candidate.path, candidate.source);
    if (!parsed) continue;
    return parsed;
  }
  return null;
}

function resolveEnvReference(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const braced = trimmed.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (braced) {
    const resolved = process.env[braced[1]]?.trim();
    return resolved || undefined;
  }

  const bare = trimmed.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (bare) {
    const resolved = process.env[bare[1]]?.trim();
    return resolved || undefined;
  }

  return trimmed;
}

function envToMap(envObj: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(envObj)) {
    if (typeof value !== 'string') continue;
    const resolved = resolveEnvReference(value);
    if (!resolved) continue;
    out.set(key.toUpperCase(), resolved);
  }
  return out;
}

function pickEnvValue(envMap: Map<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = envMap.get(key);
    if (value) return value;
  }
  return undefined;
}

function pickProcessEnvValue(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function extractJiraConfig(servers: Record<string, unknown>): Omit<JiraConfigFromMcpResult, 'source' | 'path'> {
  for (const [serverKey, serverConfig] of Object.entries(servers)) {
    if (!isRovoServerKey(serverKey)) continue;
    let envMap = new Map<string, string>();
    if (isRecord(serverConfig) && isRecord(serverConfig.env)) {
      envMap = envToMap(serverConfig.env);
    }
    const baseUrl = normalizeBaseUrl(
      pickEnvValue(envMap, BASE_URL_ENV_KEYS) || pickProcessEnvValue(BASE_URL_ENV_KEYS)
    );
    const email = pickEnvValue(envMap, EMAIL_ENV_KEYS) || pickProcessEnvValue(EMAIL_ENV_KEYS);
    const apiToken =
      pickEnvValue(envMap, TOKEN_ENV_KEYS) || pickProcessEnvValue(TOKEN_ENV_KEYS);

    return { baseUrl, email, apiToken };
  }

  return {};
}

/**
 * Parse user-pointed config file (TOML). Expects [mcpServers.*] or equivalent with a key containing "rovo".
 */
function checkTomlConfigPath(
  configPath: string,
  workspaceRoot: string | null
): RovoMcpCheckResult | null {
  const resolved = readTomlServers(configPath, workspaceRoot);
  if (resolved && hasRovoInServers(resolved.servers)) {
    return { configured: true, source: resolved.source, path: resolved.path };
  }
  return null;
}

/**
 * Check .cursor/mcp.json (workspace then global), then .codex/config.toml.
 */
function checkMcpJson(workspaceRoot: string | null): RovoMcpCheckResult {
  const resolved = readMcpJsonServers(workspaceRoot);
  if (resolved && hasRovoInServers(resolved.servers)) {
    return { configured: true, source: resolved.source, path: resolved.path };
  }
  const fromCodex = readCodexTomlServers(workspaceRoot);
  if (fromCodex && hasRovoInServers(fromCodex.servers)) {
    return { configured: true, source: fromCodex.source, path: fromCodex.path };
  }
  return { configured: false, source: null, path: null };
}

/**
 * Returns whether Rovo MCP appears to be configured.
 * If configPath is set (e.g. to config.toml), that file is parsed as TOML first.
 * Otherwise falls back to .cursor/mcp.json (workspace then global).
 */
export function isRovoMcpConfigured(
  workspaceRoot: string | null,
  configPath?: string | null
): RovoMcpCheckResult {
  const trimmed = configPath?.trim();
  if (trimmed) {
    const fromToml = checkTomlConfigPath(trimmed, workspaceRoot);
    if (fromToml) return fromToml;
    // User pointed to a file but it didn't have Rovo (or file missing) — still fall back to mcp.json
  }
  return checkMcpJson(workspaceRoot);
}

/**
 * Extract Jira credentials from Codex/Cursor MCP config:
 * - nspec.rovoMcpConfigPath (TOML) when provided
 * - otherwise .cursor/mcp.json (workspace, then global)
 * - then .codex/config.toml (workspace, then global)
 */
export function getJiraConfigFromRovoMcp(
  workspaceRoot: string | null,
  configPath?: string | null
): JiraConfigFromMcpResult {
  const trimmed = configPath?.trim();

  let resolved: ResolvedServers | null = null;
  if (trimmed) {
    const fromToml = readTomlServers(trimmed, workspaceRoot);
    if (fromToml && hasRovoInServers(fromToml.servers)) {
      resolved = fromToml;
    }
  }
  if (!resolved) {
    const fromJson = readMcpJsonServers(workspaceRoot);
    if (fromJson && hasRovoInServers(fromJson.servers)) {
      resolved = fromJson;
    }
  }
  if (!resolved) {
    const fromCodex = readCodexTomlServers(workspaceRoot);
    if (fromCodex && hasRovoInServers(fromCodex.servers)) {
      resolved = fromCodex;
    }
  }

  if (!resolved) {
    return { source: null, path: null };
  }

  return {
    ...extractJiraConfig(resolved.servers),
    source: resolved.source,
    path: resolved.path,
  };
}
