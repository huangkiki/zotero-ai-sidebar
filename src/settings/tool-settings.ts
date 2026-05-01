import type { PrefsStore } from './storage';

export type WebSearchMode = 'disabled' | 'cached' | 'live';
export type McpApprovalMode = 'never' | 'always';

export interface ArxivMcpSettings {
  enabled: boolean;
  serverLabel: string;
  serverUrl: string;
  allowedTools: string[];
  requireApproval: McpApprovalMode;
}

export interface McpServerSettings {
  id: string;
  enabled: boolean;
  serverLabel: string;
  serverUrl: string;
  allowedTools: string[];
  requireApproval: McpApprovalMode;
}

export interface ToolSettings {
  webSearchMode: WebSearchMode;
  mcpServers: McpServerSettings[];
  // Legacy arXiv MCP shape kept only for migration/back-compat. The current
  // arXiv reader is a fixed local AgentTool, not a user-configured MCP.
  arxivMcp: ArxivMcpSettings;
}

export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  webSearchMode: 'disabled',
  mcpServers: [],
  arxivMcp: {
    enabled: false,
    serverLabel: 'arxiv',
    serverUrl: '',
    allowedTools: ['search'],
    requireApproval: 'never',
  },
};

const KEY = 'extensions.zotero-ai-sidebar.toolSettings';
const LABEL_MAX_LENGTH = 64;
const MAX_MCP_SERVERS = 8;

export function loadToolSettings(prefs: PrefsStore): ToolSettings {
  const raw = prefs.get(KEY);
  if (!raw) return DEFAULT_TOOL_SETTINGS;
  try {
    return normalizeToolSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_TOOL_SETTINGS;
  }
}

export function saveToolSettings(
  prefs: PrefsStore,
  settings: ToolSettings,
): void {
  prefs.set(KEY, JSON.stringify(normalizeToolSettings(settings)));
}

function normalizeToolSettings(value: unknown): ToolSettings {
  const input =
    value && typeof value === 'object' ? (value as Partial<ToolSettings>) : {};
  const rawArxiv =
    input.arxivMcp && typeof input.arxivMcp === 'object'
      ? (input.arxivMcp as Partial<ArxivMcpSettings>)
      : {};
  return {
    webSearchMode: isWebSearchMode(input.webSearchMode)
      ? input.webSearchMode
      : DEFAULT_TOOL_SETTINGS.webSearchMode,
    mcpServers: normalizeMcpServers(input.mcpServers),
    arxivMcp: {
      enabled: rawArxiv.enabled === true,
      serverLabel: normalizeServerLabel(rawArxiv.serverLabel),
      serverUrl: stringValue(rawArxiv.serverUrl),
      allowedTools: normalizeAllowedTools(
        rawArxiv.allowedTools,
        DEFAULT_TOOL_SETTINGS.arxivMcp.allowedTools,
      ),
      requireApproval:
        rawArxiv.requireApproval === 'always' ? 'always' : 'never',
    },
  };
}

function normalizeMcpServers(value: unknown): McpServerSettings[] {
  if (!Array.isArray(value)) return [];
  const servers: McpServerSettings[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<McpServerSettings>;
    const serverLabel = normalizeServerLabel(item.serverLabel);
    const id = uniqueID(stringValue(item.id) || serverLabel, seen);
    servers.push({
      id,
      enabled: item.enabled === true,
      serverLabel,
      serverUrl: stringValue(item.serverUrl),
      allowedTools: normalizeAllowedTools(item.allowedTools, []),
      requireApproval: item.requireApproval === 'always' ? 'always' : 'never',
    });
    if (servers.length >= MAX_MCP_SERVERS) break;
  }
  return servers;
}

function isWebSearchMode(value: unknown): value is WebSearchMode {
  return value === 'disabled' || value === 'cached' || value === 'live';
}

function normalizeAllowedTools(value: unknown, fallback: string[]): string[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : fallback;
  const seen = new Set<string>();
  const tools: string[] = [];
  for (const entry of source) {
    const tool = stringValue(entry);
    if (!tool || seen.has(tool)) continue;
    seen.add(tool);
    tools.push(tool);
  }
  return tools.length ? tools : fallback;
}

function normalizeServerLabel(value: unknown): string {
  const label = stringValue(value)
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LABEL_MAX_LENGTH);
  return label || DEFAULT_TOOL_SETTINGS.arxivMcp.serverLabel;
}

function uniqueID(value: string, seen: Set<string>): string {
  const base = value
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LABEL_MAX_LENGTH) || `mcp-${seen.size + 1}`;
  let id = base;
  let suffix = 2;
  while (seen.has(id)) id = `${base}-${suffix++}`;
  seen.add(id);
  return id;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
