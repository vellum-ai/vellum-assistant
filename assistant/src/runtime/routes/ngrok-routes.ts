/**
 * Route handlers for public-ingress ngrok integration.
 *
 * POST /v1/integrations/public-ingress/ngrok/auth — configure ngrok auth token server-side
 */

import { getSecureKey, setSecureKey } from '../../security/secure-keys.js';
import { upsertCredentialMetadata } from '../../tools/credentials/metadata-store.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('ngrok-routes');

/**
 * POST /v1/integrations/public-ingress/ngrok/auth
 *
 * Body: { authToken?: string }
 *
 * Accepts an explicit auth token in the body or an empty body `{}`.
 * When the body omits the token, it is resolved from secure storage
 * (`credential:ngrok:authtoken`). Runs `ngrok config add-authtoken`
 * server-side so the token never appears in conversation context.
 */
export async function handleNgrokAuth(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { authToken?: string };

  // Resolve token: prefer explicit body value, fall back to secure storage
  const authToken = body.authToken || getSecureKey('credential:ngrok:authtoken');

  if (!authToken) {
    return Response.json({
      success: false,
      hasToken: false,
      source: 'none',
      error: 'Missing ngrok auth token. Provide it in the request body or store it via credential_store first.',
    }, { status: 400 });
  }

  const source = body.authToken ? 'body' : 'secure_storage';

  // Run ngrok config add-authtoken server-side
  try {
    const proc = Bun.spawn(['ngrok', 'config', 'add-authtoken', authToken], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      log.warn({ exitCode, stderr: stderr.slice(0, 500) }, 'ngrok config add-authtoken failed');
      return Response.json({
        success: false,
        hasToken: true,
        source,
        error: `ngrok config add-authtoken failed (exit ${exitCode}): ${stderr.trim().slice(0, 200)}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to run ngrok config add-authtoken');
    return Response.json({
      success: false,
      hasToken: true,
      source,
      error: `Failed to run ngrok command: ${message}`,
    });
  }

  // If the token was provided in the body, persist it to secure storage
  let warning: string | undefined;
  if (body.authToken) {
    const stored = setSecureKey('credential:ngrok:authtoken', body.authToken);
    if (stored) {
      upsertCredentialMetadata('ngrok', 'authtoken', {});
    } else {
      log.warn('Failed to persist ngrok auth token to secure storage');
      warning = 'ngrok was configured successfully, but the token could not be persisted to secure storage. It may need to be provided again next time.';
    }
  }

  return Response.json({
    success: true,
    hasToken: true,
    source,
    ...(warning ? { warning } : {}),
  });
}
