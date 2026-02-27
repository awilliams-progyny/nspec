import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchJiraIssueAsUserStory,
  fetchJiraIssueForSpec,
  parseJiraReference,
  parseJiraUrl,
} from '../../jira';

describe('parseJiraUrl', () => {
  it('parses classic browse URLs', () => {
    const parsed = parseJiraUrl('https://example.atlassian.net/browse/ET-1905');
    expect(parsed).toEqual({ host: 'example.atlassian.net', issueKey: 'ET-1905' });
  });

  it('parses modern Jira issue URLs', () => {
    const parsed = parseJiraUrl(
      'https://example.atlassian.net/jira/software/c/projects/ET/issues/et-1905'
    );
    expect(parsed).toEqual({ host: 'example.atlassian.net', issueKey: 'ET-1905' });
  });

  it('parses issue keys from selectedIssue query params', () => {
    const parsed = parseJiraUrl(
      'https://example.atlassian.net/jira/software/projects/ET/boards/1?selectedIssue=ET-1905'
    );
    expect(parsed).toEqual({ host: 'example.atlassian.net', issueKey: 'ET-1905' });
  });

  it('parses issue keys from JQL query params', () => {
    const parsed = parseJiraUrl(
      'https://example.atlassian.net/jira/software/projects/ET/boards/1?jql=project%20%3D%20ET%20AND%20issueKey%20%3D%20ET-1905'
    );
    expect(parsed).toEqual({ host: 'example.atlassian.net', issueKey: 'ET-1905' });
  });

  it('returns null for non-URL input', () => {
    expect(parseJiraUrl('ET-1905')).toBeNull();
  });
});

describe('parseJiraReference', () => {
  it('accepts issue keys', () => {
    const parsed = parseJiraReference('et-1905');
    expect(parsed).toEqual({
      kind: 'issue-key',
      raw: 'et-1905',
      issueKey: 'ET-1905',
    });
  });

  it('accepts issue URLs', () => {
    const parsed = parseJiraReference('https://example.atlassian.net/browse/ET-1905');
    expect(parsed).toEqual({
      kind: 'url',
      raw: 'https://example.atlassian.net/browse/ET-1905',
      issueKey: 'ET-1905',
      host: 'example.atlassian.net',
    });
  });
});

describe('fetchJiraIssueAsUserStory', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects partial Jira credentials before making a request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

    await expect(
      fetchJiraIssueAsUserStory('https://example.atlassian.net/browse/ET-1905', {
        email: 'dev@example.com',
      })
    ).rejects.toThrow(/Set both Jira email and Jira API token/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows a private-project hint on 404 without credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }) as unknown as typeof fetch
    );

    await expect(
      fetchJiraIssueAsUserStory('https://example.atlassian.net/browse/ET-1905', {})
    ).rejects.toThrow(/private projects usually require jira email \+ api token/i);
  });
});

describe('fetchJiraIssueForSpec', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts issue keys when baseUrl is provided', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          key: 'ET-1905',
          fields: {
            summary: 'Ticket summary',
            issuetype: { name: 'Task' },
            description: { type: 'doc', content: [{ type: 'text', text: 'Ticket body' }] },
          },
        }),
      }) as unknown as typeof fetch
    );

    const issue = await fetchJiraIssueForSpec('ET-1905', {
      baseUrl: 'https://example.atlassian.net',
    });

    expect(issue.key).toBe('ET-1905');
    expect(issue.summary).toBe('Ticket summary');
    expect(issue.issueType).toBe('Task');
  });

  it('does not enforce story-only type for spec generation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          key: 'ET-2000',
          fields: {
            summary: 'Epic summary',
            issuetype: { name: 'Epic' },
            description: { type: 'doc', content: [{ type: 'text', text: 'Epic details' }] },
          },
        }),
      }) as unknown as typeof fetch
    );

    const issue = await fetchJiraIssueForSpec(
      'https://example.atlassian.net/browse/ET-2000',
      {}
    );

    expect(issue.issueType).toBe('Epic');
  });
});
