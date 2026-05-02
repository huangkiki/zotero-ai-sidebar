// Minimal WebDAV client: just enough to put/get one JSON file and
// idempotently create the parent folder. Tested against 坚果云 (Nutstore)
// and NextCloud; sticks to RFC 4918 verbs that all WebDAV servers support.
//
// SCOPE NOTE: this is intentionally not a general-purpose WebDAV library.
// We push/pull a single sync file, so we don't need PROPFIND parsing,
// LOCK, or property storage.
//
// AUTHENTICATION: HTTP Basic only. 坚果云 requires an "应用密码" (app
// password generated in account settings), not the login password — same
// as the credential users put into Zotero's built-in WebDAV File Sync.

export interface WebDavConfig {
  baseUrl: string; // e.g. "https://dav.jianguoyun.com/dav/"
  username: string;
  password: string;
}

export interface WebDavGetResult {
  found: boolean;
  body: string; // empty string when found === false
  lastModified: string; // empty string when missing
}

export class WebDavError extends Error {
  status: number;
  url: string;
  bodySnippet: string;
  constructor(message: string, status: number, url: string, bodySnippet = '') {
    super(message);
    this.name = 'WebDavError';
    this.status = status;
    this.url = url;
    this.bodySnippet = bodySnippet;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

export async function ensureFolder(
  config: WebDavConfig,
  folderPath: string,
): Promise<void> {
  // MKCOL is idempotent only via 405 (already exists); 201 is the create
  // path. Anything else surfaces as a WebDavError so the UI can show it.
  const url = joinUrl(config.baseUrl, folderPath, true);
  const response = await sendRequest(config, 'MKCOL', url);
  if (response.status === 201 || response.status === 405) return;
  // Some servers (NextCloud) return 301 if we forgot the trailing slash —
  // joinUrl always adds it for collections, so this branch shouldn't hit,
  // but handle it permissively anyway.
  if (response.status === 301 || response.status === 302) return;
  throw await buildError(response, url, 'create folder');
}

export async function putFile(
  config: WebDavConfig,
  filePath: string,
  body: string,
): Promise<void> {
  const url = joinUrl(config.baseUrl, filePath, false);
  const response = await sendRequest(config, 'PUT', url, body, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  // 200/201/204 are all valid PUT outcomes per RFC 4918.
  if (response.status >= 200 && response.status < 300) return;
  throw await buildError(response, url, 'upload file');
}

export async function getFile(
  config: WebDavConfig,
  filePath: string,
): Promise<WebDavGetResult> {
  const url = joinUrl(config.baseUrl, filePath, false);
  const response = await sendRequest(config, 'GET', url);
  if (response.status === 404) {
    return { found: false, body: '', lastModified: '' };
  }
  if (response.status >= 200 && response.status < 300) {
    return {
      found: true,
      body: await response.text(),
      lastModified: response.headers.get('Last-Modified') ?? '',
    };
  }
  throw await buildError(response, url, 'download file');
}

export async function testAuth(config: WebDavConfig): Promise<void> {
  // PROPFIND with Depth: 0 on the base URL is the standard "are these
  // credentials valid" probe. 207 (Multi-Status) is success; 401/403 are
  // auth failures we want to surface clearly.
  const url = joinUrl(config.baseUrl, '', true);
  const response = await sendRequest(config, 'PROPFIND', url, undefined, {
    Depth: '0',
    'Content-Type': 'application/xml; charset=utf-8',
  });
  if (response.status === 207 || response.status === 200) return;
  throw await buildError(response, url, 'verify credentials');
}

function joinUrl(base: string, path: string, isCollection: boolean): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.replace(/^\/+|\/+$/g, '');
  const joined = trimmedPath ? `${trimmedBase}/${trimmedPath}` : trimmedBase;
  // Collections (folders) MUST end in a slash for PROPFIND/MKCOL semantics.
  // Files MUST NOT — some servers route the trailing-slash form to a
  // directory listing instead of the file itself.
  if (isCollection && !joined.endsWith('/')) return `${joined}/`;
  if (!isCollection && joined.endsWith('/')) return joined.slice(0, -1);
  return joined;
}

async function sendRequest(
  config: WebDavConfig,
  method: string,
  url: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      headers: {
        Authorization: basicAuthHeader(config.username, config.password),
        ...extraHeaders,
      },
      body,
      signal: controller.signal,
      // WebDAV is cross-origin from Zotero's privileged context, but the
      // chrome:// origin is allowed to bypass CORS. No `mode` needed.
    });
  } finally {
    clearTimeout(timeout);
  }
}

function basicAuthHeader(username: string, password: string): string {
  const raw = `${username}:${password}`;
  // btoa exists in Zotero's privileged context (XPCOM/JSM globals); fall
  // back to a manual base64 only if a host without it ever runs the code.
  const encoded =
    typeof btoa === 'function'
      ? btoa(unescape(encodeURIComponent(raw)))
      : Buffer.from(raw, 'utf-8').toString('base64');
  return `Basic ${encoded}`;
}

async function buildError(
  response: Response,
  url: string,
  operation: string,
): Promise<WebDavError> {
  let snippet = '';
  try {
    const text = await response.text();
    snippet = text.slice(0, 280);
  } catch {
    snippet = '';
  }
  const reason =
    response.status === 401
      ? '认证失败，请检查用户名/应用密码'
      : response.status === 403
        ? '权限不足，请检查 WebDAV 账号是否允许该路径'
        : response.status === 404
          ? '路径不存在'
          : response.status === 507
            ? 'WebDAV 服务器存储空间不足'
            : `HTTP ${response.status}`;
  return new WebDavError(
    `${operation} 失败：${reason}`,
    response.status,
    url,
    snippet,
  );
}
