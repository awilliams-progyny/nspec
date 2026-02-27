/**
 * Jira Cloud integration: fetch issue by URL and validate it is a user story.
 * Used as an alternative to free-text description when creating a spec from a Jira ticket.
 */

const JIRA_STORY_NAMES = ['story', 'user story'];
const ISSUE_KEY_REGEX = /\b([A-Z][A-Z0-9]+-\d+)\b/i;
const ISSUE_KEY_ONLY_REGEX = /^[A-Z][A-Z0-9]+-\d+$/i;

export interface JiraIssueResult {
  key: string;
  summary: string;
  description: string;
  issueType: string;
}

export interface JiraConfig {
  baseUrl?: string;
  email?: string;
  apiToken?: string;
}

export interface JiraReference {
  kind: 'url' | 'issue-key';
  raw: string;
  issueKey: string;
  host?: string;
}

interface JiraFetchOptions {
  requireStory?: boolean;
}

/** Partial Atlassian Document Format node shape. */
interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

/**
 * Parse a Jira browse URL to extract host and issue key.
 * Supports:
 * - https://domain.atlassian.net/browse/PROJ-123
 * - https://domain.atlassian.net/jira/software/c/projects/PROJ/issues/PROJ-123
 * - URLs carrying an issue key in common query params (selectedIssue, issueKey, jql)
 * Returns null if not a valid Jira URL we can use for API.
 */
export function parseJiraUrl(url: string): { host: string; issueKey: string } | null {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const host = parsed.host;
  if (!host) return null;

  const keyFromPath =
    parsed.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)(?:\/)?$/i)?.[1] ||
    parsed.pathname.match(/\/issues\/([A-Z][A-Z0-9]+-\d+)(?:\/)?$/i)?.[1];
  if (keyFromPath) {
    return { host, issueKey: keyFromPath.toUpperCase() };
  }

  const queryCandidates = ['selectedIssue', 'selectedissue', 'issueKey', 'issuekey', 'issue'];
  for (const q of queryCandidates) {
    const value = parsed.searchParams.get(q);
    const match = value?.match(ISSUE_KEY_REGEX)?.[1];
    if (match) {
      return { host, issueKey: match.toUpperCase() };
    }
  }

  const jql = parsed.searchParams.get('jql');
  const jqlMatch = jql?.match(ISSUE_KEY_REGEX)?.[1];
  if (jqlMatch) {
    return { host, issueKey: jqlMatch.toUpperCase() };
  }

  return null;
}

/**
 * Parse a Jira reference entered by users.
 * Accepts full Jira issue URLs or bare issue keys like ET-1905.
 */
export function parseJiraReference(input: string): JiraReference | null {
  const raw = input.trim();
  if (!raw) return null;

  const parsedUrl = parseJiraUrl(raw);
  if (parsedUrl) {
    return {
      kind: 'url',
      raw,
      issueKey: parsedUrl.issueKey,
      host: parsedUrl.host,
    };
  }

  if (ISSUE_KEY_ONLY_REGEX.test(raw)) {
    return {
      kind: 'issue-key',
      raw,
      issueKey: raw.toUpperCase(),
    };
  }

  return null;
}

/**
 * Convert Atlassian Document Format (ADF) description to plain text.
 * Handles common node types: paragraph, text, heading, listItem, bulletList, orderedList, codeBlock.
 */
function adfToPlainText(node: AdfNode | string | null | undefined): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (node.text) return node.text;
  if (!Array.isArray(node.content)) return '';
  return node.content.map((c) => adfToPlainText(c)).join('');
}

function resolveJiraBaseUrl(ref: JiraReference, config: JiraConfig): string {
  const fromConfig = config.baseUrl?.trim();
  if (fromConfig) {
    return fromConfig.replace(/\/$/, '');
  }
  if (ref.kind === 'url' && ref.host) {
    return `https://${ref.host}`;
  }
  throw new Error(
    'Jira base URL is required when using an issue key like ET-1905. Configure it in your Rovo MCP env (e.g. ATLASSIAN_URL) or nSpec settings.'
  );
}

function buildJiraAuthHeaders(config: JiraConfig): Record<string, string> {
  const hasEmail = Boolean(config.email?.trim());
  const hasApiToken = Boolean(config.apiToken?.trim());
  if (hasEmail !== hasApiToken) {
    throw new Error(
      'Set both Jira email and Jira API token in Settings -> nSpec, or leave both empty.'
    );
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (hasEmail && hasApiToken) {
    const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
    headers.Authorization = `Basic ${auth}`;
  }
  return headers;
}

async function fetchJiraIssue(
  jiraRefInput: string,
  config: JiraConfig,
  options?: JiraFetchOptions
): Promise<JiraIssueResult> {
  const parsed = parseJiraReference(jiraRefInput);
  if (!parsed) {
    throw new Error(
      'Invalid Jira reference. Use a Jira issue URL or key, e.g. https://your-domain.atlassian.net/browse/PROJ-123 or PROJ-123.'
    );
  }

  const baseUrl = resolveJiraBaseUrl(parsed, config);
  const apiUrl = `${baseUrl}/rest/api/3/issue/${parsed.issueKey}`;
  const headers = buildJiraAuthHeaders(config);
  const hasAuth = Boolean(headers.Authorization);
  const res = await fetch(apiUrl, { method: 'GET', headers });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        'Jira authentication failed. Check your Rovo MCP credentials or Settings -> nSpec -> Jira email/token.'
      );
    }
    if (res.status === 403) {
      throw new Error(
        'Jira access denied (403). Confirm your account can view this issue and project.'
      );
    }
    if (res.status === 404) {
      if (!hasAuth) {
        throw new Error(
          `Jira issue ${parsed.issueKey} was not returned (404). Private projects usually require Jira email + API token in Rovo MCP env or nSpec settings.`
        );
      }
      throw new Error(
        `Jira issue ${parsed.issueKey} was not returned (404). Confirm the key is correct and your account can access it.`
      );
    }
    throw new Error(`Jira request failed (${res.status}). Check the URL and Jira settings.`);
  }

  const data = (await res.json()) as {
    key?: string;
    fields?: {
      summary?: string;
      description?: AdfNode;
      issuetype?: { name?: string };
    };
  };

  const key = data.key || parsed.issueKey;
  const fields = data.fields || {};
  const issueType = (fields.issuetype?.name || '').trim();
  const typeLower = issueType.toLowerCase();

  const isStory = JIRA_STORY_NAMES.some((name) => typeLower === name);
  if (options?.requireStory && !isStory) {
    throw new Error(
      `Only Jira user stories are supported. This issue is a "${issueType}". Use a Story/User Story or enter a description instead.`
    );
  }

  const summary = (fields.summary || '').trim();
  let description = '';
  const descNode = fields.description;
  if (descNode) {
    description = adfToPlainText(descNode).trim();
  }

  return {
    key,
    summary,
    description,
    issueType,
  };
}

/**
 * Fetch Jira issue by URL or issue key for spec generation.
 * This accepts any Jira issue type (Story, Task, Bug, Epic, etc.).
 */
export async function fetchJiraIssueForSpec(
  jiraReference: string,
  config: JiraConfig
): Promise<JiraIssueResult> {
  return fetchJiraIssue(jiraReference, config, { requireStory: false });
}

export async function fetchJiraIssueAsUserStory(
  jiraUrl: string,
  config: JiraConfig
): Promise<JiraIssueResult> {
  return fetchJiraIssue(jiraUrl, config, { requireStory: true });
}

/**
 * Build a single prompt string from a Jira user story (for use as the initial spec description).
 */
export function jiraIssueToPrompt(issue: JiraIssueResult): string {
  const parts = [`# ${issue.key}: ${issue.summary}`];
  if (issue.description) {
    parts.push('', issue.description);
  }
  return parts.join('\n');
}
