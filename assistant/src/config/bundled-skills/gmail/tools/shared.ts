import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https';
import { withValidToken } from '../../../../integrations/token-manager.js';
import { getIntegration } from '../../../../integrations/registry.js';
import type { ToolExecutionResult } from '../../../../tools/types.js';

export function getGmailDef() {
  const def = getIntegration('gmail');
  if (!def) throw new Error('Gmail integration not registered');
  return def;
}

export function ok(content: string): ToolExecutionResult {
  return { content, isError: false };
}

export function err(message: string): ToolExecutionResult {
  return { content: message, isError: true };
}

export async function withGmailToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const def = getGmailDef();
  return withValidToken('gmail', def, fn);
}

/** Make an HTTPS request pinned to a specific resolved IP to prevent DNS rebinding. */
export function pinnedHttpsRequest(
  target: URL,
  resolvedAddress: string,
  options?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const reqOpts: HttpsRequestOptions = {
      method: options?.method ?? 'GET',
      hostname: resolvedAddress,
      port: target.port ? Number(target.port) : undefined,
      path: `${target.pathname}${target.search}`,
      headers: { host: target.host, ...options?.headers },
      servername: target.hostname,
    };
    const req = httpsRequest(reqOpts, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once('error', reject);
    if (options?.body) req.write(options.body);
    req.end();
  });
}
