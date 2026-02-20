#!/usr/bin/env bun
/**
 * Capture X.com GraphQL API calls via Chrome CDP.
 *
 * Usage:
 *   1. Make sure Chrome is running with CDP (vellum x refresh will do this)
 *   2. Run: bun run scripts/capture-x-graphql.ts
 *   3. Browse X in Chrome — visit a profile, scroll their tweets, reply to one
 *   4. Press Ctrl+C to stop. Captured queries are printed as JSON.
 */

const CDP_BASE = 'http://localhost:9222';

interface CapturedQuery {
  queryName: string;
  queryId: string;
  method: string;
  url: string;
  variables: unknown;
  features?: unknown;
  responsePreview?: unknown;
}

const captured: CapturedQuery[] = [];

// Minimal CDP WebSocket client
class CDPClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private callbacks = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Map<string, Array<(params: Record<string, unknown>) => void>>();

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => { this.ws = ws; resolve(); };
      ws.onerror = (e) => reject(new Error(`CDP error: ${e}`));
      ws.onclose = () => { this.ws = null; };
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id != null) {
          const cb = this.callbacks.get(msg.id);
          if (cb) { this.callbacks.delete(msg.id); msg.error ? cb.reject(new Error(msg.error.message)) : cb.resolve(msg.result); }
        } else if (msg.method) {
          for (const h of this.eventHandlers.get(msg.method) ?? []) h(msg.params ?? {});
        }
      };
    });
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (params: Record<string, unknown>) => void) {
    const list = this.eventHandlers.get(event) ?? [];
    list.push(handler);
    this.eventHandlers.set(event, list);
  }

  close() { this.ws?.close(); }
}

// Discover Chrome tabs
const res = await fetch(`${CDP_BASE}/json/list`);
if (!res.ok) {
  console.error('Chrome CDP not available. Run `vellum x refresh` first.');
  process.exit(1);
}
const targets = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
const pages = targets.filter(t => t.type === 'page');

if (pages.length === 0) {
  console.error('No pages found in Chrome.');
  process.exit(1);
}

console.log(`Found ${pages.length} tab(s). Attaching to all...`);

// Pending request data (requestId -> partial info)
const pendingRequests = new Map<string, { url: string; postData?: string }>();

for (const page of pages) {
  const client = new CDPClient();
  await client.connect(page.webSocketDebuggerUrl);
  await client.send('Network.enable');

  client.on('Network.requestWillBeSent', (params) => {
    const req = params.request as Record<string, unknown> | undefined;
    const url = (req?.url ?? params.url) as string | undefined;
    if (!url?.includes('/i/api/graphql/')) return;
    const method = (req?.method as string) ?? 'GET';
    pendingRequests.set(params.requestId as string, {
      url,
      postData: req.postData as string | undefined,
    });

    // Extract query name from URL: /graphql/<queryId>/<QueryName>
    const match = url.match(/\/graphql\/([^/]+)\/([^?]+)/);
    const queryId = match?.[1] ?? 'unknown';
    const queryName = match?.[2] ?? 'unknown';

    let variables: unknown = undefined;
    let features: unknown = undefined;

    if (method === 'POST' && req.postData) {
      try {
        const body = JSON.parse(req.postData as string);
        variables = body.variables;
        features = body.features;
      } catch { /* ignore */ }
    } else if (method === 'GET') {
      // GET requests encode variables in query params
      try {
        const u = new URL(url);
        const v = u.searchParams.get('variables');
        if (v) variables = JSON.parse(v);
        const f = u.searchParams.get('features');
        if (f) features = JSON.parse(f);
      } catch { /* ignore */ }
    }

    console.log(`\n>>> ${method} ${queryName} (${queryId})`);
    if (variables) console.log(`    variables: ${JSON.stringify(variables).slice(0, 200)}`);

    captured.push({ queryName, queryId, method, url, variables, features });
  });

  client.on('Network.responseReceived', (params) => {
    const requestId = params.requestId as string;
    const pending = pendingRequests.get(requestId);
    if (!pending) return;

    const response = params.response as Record<string, unknown>;
    const status = response.status as number;
    console.log(`    <<< ${status}`);

    // Try to get response body
    client.send('Network.getResponseBody', { requestId }).then((result) => {
      const body = (result as Record<string, unknown>).body as string;
      try {
        const json = JSON.parse(body);
        // Attach a preview to the last captured entry with matching URL
        const entry = [...captured].reverse().find(e => e.url === pending.url);
        if (entry) entry.responsePreview = JSON.stringify(json).slice(0, 500);
      } catch { /* ignore */ }
    }).catch(() => { /* body not available yet */ });

    pendingRequests.delete(requestId);
  });
}

console.log('\nRecording X.com GraphQL requests...');
console.log('Browse X in Chrome — visit a profile, scroll tweets, reply to one.');
console.log('Press Ctrl+C to stop and dump results.\n');

// Wait for Ctrl+C
process.on('SIGINT', () => {
  console.log(`\n\n=== Captured ${captured.length} GraphQL requests ===\n`);

  // Dedupe by queryName, keep first occurrence
  const seen = new Set<string>();
  const unique = captured.filter(q => {
    if (seen.has(q.queryName)) return false;
    seen.add(q.queryName);
    return true;
  });

  for (const q of unique) {
    console.log(`--- ${q.queryName} ---`);
    console.log(`  Query ID: ${q.queryId}`);
    console.log(`  Method: ${q.method}`);
    console.log(`  Variables: ${JSON.stringify(q.variables, null, 2)}`);
    if (q.responsePreview) {
      console.log(`  Response preview: ${q.responsePreview}`);
    }
    console.log('');
  }

  // Also dump full JSON
  const outPath = '/tmp/x-graphql-capture.json';
  Bun.write(outPath, JSON.stringify(captured, null, 2));
  console.log(`Full capture saved to ${outPath}`);
  process.exit(0);
});
