import { describe, expect, it } from 'vitest';
import type { PrefsStore } from '../../src/settings/storage';
import {
  DEFAULT_TOOL_SETTINGS,
  loadToolSettings,
  saveToolSettings,
} from '../../src/settings/tool-settings';

function memPrefs(): PrefsStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
  };
}

describe('tool settings storage', () => {
  it('returns defaults for missing or invalid values', () => {
    expect(loadToolSettings(memPrefs())).toEqual(DEFAULT_TOOL_SETTINGS);
    const prefs = memPrefs();
    prefs.set('extensions.zotero-ai-sidebar.toolSettings', '{broken');
    expect(loadToolSettings(prefs)).toEqual(DEFAULT_TOOL_SETTINGS);
  });

  it('round trips configured web and arxiv MCP settings', () => {
    const prefs = memPrefs();
    saveToolSettings(prefs, {
      webSearchMode: 'live',
      mcpServers: [],
      arxivMcp: {
        enabled: true,
        serverLabel: 'arxiv-search',
        serverUrl: 'https://example.test/mcp',
        allowedTools: ['search', 'fetch_pdf'],
        requireApproval: 'always',
      },
    });
    expect(loadToolSettings(prefs)).toEqual({
      webSearchMode: 'live',
      mcpServers: [],
      arxivMcp: {
        enabled: true,
        serverLabel: 'arxiv-search',
        serverUrl: 'https://example.test/mcp',
        allowedTools: ['search', 'fetch_pdf'],
        requireApproval: 'always',
      },
    });
  });

  it('normalizes malformed arxiv MCP values', () => {
    const prefs = memPrefs();
    prefs.set(
      'extensions.zotero-ai-sidebar.toolSettings',
      JSON.stringify({
        webSearchMode: 'bad',
        arxivMcp: {
          enabled: true,
          serverLabel: ' arxiv search!* ',
          serverUrl: 12,
          allowedTools: ['search', 'search', '', 'read'],
          requireApproval: 'bad',
        },
      }),
    );
    expect(loadToolSettings(prefs)).toEqual({
      webSearchMode: 'disabled',
      mcpServers: [],
      arxivMcp: {
        enabled: true,
        serverLabel: 'arxiv-search',
        serverUrl: '',
        allowedTools: ['search', 'read'],
        requireApproval: 'never',
      },
    });
  });

  it('round trips generic MCP server settings', () => {
    const prefs = memPrefs();
    saveToolSettings(prefs, {
      webSearchMode: 'disabled',
      mcpServers: [
        {
          id: 'papers',
          enabled: true,
          serverLabel: 'paper-tools',
          serverUrl: 'https://example.test/mcp',
          allowedTools: ['search', 'read_pdf'],
          requireApproval: 'never',
        },
      ],
      arxivMcp: DEFAULT_TOOL_SETTINGS.arxivMcp,
    });

    expect(loadToolSettings(prefs).mcpServers).toEqual([
      {
        id: 'papers',
        enabled: true,
        serverLabel: 'paper-tools',
        serverUrl: 'https://example.test/mcp',
        allowedTools: ['search', 'read_pdf'],
        requireApproval: 'never',
      },
    ]);
  });
});
