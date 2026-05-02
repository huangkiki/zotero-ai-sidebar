import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureFolder,
  getFile,
  putFile,
  testAuth,
  WebDavError,
} from '../../src/sync/webdav';

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

const config = {
  baseUrl: 'https://dav.example.com/dav/',
  username: 'alice',
  password: 'p@ss',
};

let recorded: RecordedRequest[] = [];
let nextResponse: Response = new Response('', { status: 200 });

beforeEach(() => {
  recorded = [];
  nextResponse = new Response('', { status: 200 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    recorded.push({
      method: init.method ?? 'GET',
      url,
      headers,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    return nextResponse;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('webdav client', () => {
  it('PUT sends body with Basic auth and JSON content type', async () => {
    nextResponse = new Response('', { status: 201 });
    await putFile(config, 'zotero-ai-sidebar/state.json', '{"a":1}');
    expect(recorded).toHaveLength(1);
    const req = recorded[0];
    expect(req.method).toBe('PUT');
    expect(req.url).toBe('https://dav.example.com/dav/zotero-ai-sidebar/state.json');
    expect(req.headers.Authorization).toMatch(/^Basic /);
    expect(req.headers['Content-Type']).toMatch(/json/);
    expect(req.body).toBe('{"a":1}');
  });

  it('GET returns body when 200, found:false when 404', async () => {
    nextResponse = new Response('hello', {
      status: 200,
      headers: { 'Last-Modified': 'Sat, 02 May 2026 00:00:00 GMT' },
    });
    const ok = await getFile(config, 'zotero-ai-sidebar/state.json');
    expect(ok.found).toBe(true);
    expect(ok.body).toBe('hello');
    expect(ok.lastModified).toContain('2026');

    nextResponse = new Response('', { status: 404 });
    const missing = await getFile(config, 'zotero-ai-sidebar/state.json');
    expect(missing.found).toBe(false);
    expect(missing.body).toBe('');
  });

  it('MKCOL accepts 201 and 405 as success', async () => {
    nextResponse = new Response('', { status: 201 });
    await ensureFolder(config, 'zotero-ai-sidebar');
    nextResponse = new Response('', { status: 405 });
    await ensureFolder(config, 'zotero-ai-sidebar');
    // Both URLs end with a trailing slash for collections.
    for (const req of recorded) {
      expect(req.url.endsWith('/')).toBe(true);
      expect(req.method).toBe('MKCOL');
    }
  });

  it('PROPFIND uses Depth: 0', async () => {
    nextResponse = new Response('<xml/>', { status: 207 });
    await testAuth(config);
    expect(recorded[0].method).toBe('PROPFIND');
    expect(recorded[0].headers.Depth).toBe('0');
  });

  it('surfaces 401 as a WebDavError with a Chinese auth message', async () => {
    nextResponse = new Response('nope', { status: 401 });
    await expect(getFile(config, 'state.json')).rejects.toBeInstanceOf(WebDavError);
    nextResponse = new Response('nope', { status: 401 });
    try {
      await getFile(config, 'state.json');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WebDavError);
      expect((err as WebDavError).status).toBe(401);
      expect((err as WebDavError).message).toMatch(/认证失败/);
    }
  });

  it('joins base URL and path without producing double slashes', async () => {
    nextResponse = new Response('', { status: 200 });
    await getFile(
      { ...config, baseUrl: 'https://dav.example.com/dav' },
      '/sub/file.json',
    );
    expect(recorded[0].url).toBe('https://dav.example.com/dav/sub/file.json');
  });
});
