export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  prompt: (args: string) => string;
}

// Explicit user shortcuts only. They do not execute local logic directly;
// they expand to a visible instruction and let the model choose the tools
// exposed in the provider request.
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/arxiv-search',
    usage: '/arxiv-search <query or arXiv URL>',
    description:
      'Search arXiv or inspect an arXiv paper with available tools.',
    prompt: (args) =>
      [
        'User explicitly selected /arxiv-search.',
        args
          ? `Search/analyze request: ${args}`
          : 'No query was provided. If the current Zotero item title/abstract is enough, use it as the query; otherwise ask the user what to search.',
      ].join('\n'),
  },
  {
    name: '/web-search',
    usage: '/web-search <query>',
    description: 'Search the web with the configured built-in search tool.',
    prompt: (args) =>
      [
        'User explicitly selected /web-search.',
        'Use the configured built-in web search tool when it is available. If no web search tool is available, say that search is not enabled instead of pretending to search.',
        args
          ? `Search request: ${args}`
          : 'No query was provided; ask for a query.',
      ].join('\n'),
  },
];

export function matchingSlashCommands(token: string): SlashCommand[] {
  const normalized = token.startsWith('/') ? token : `/${token}`;
  return SLASH_COMMANDS.filter((command) =>
    command.name.startsWith(normalized),
  );
}

export function expandSlashCommandMessage(content: string): string {
  const trimmedStart = content.match(/^\s*/)?.[0] ?? '';
  const rest = content.slice(trimmedStart.length);
  for (const command of SLASH_COMMANDS) {
    if (rest === command.name || rest.startsWith(`${command.name} `)) {
      return command.prompt(rest.slice(command.name.length).trim());
    }
  }
  return content;
}
