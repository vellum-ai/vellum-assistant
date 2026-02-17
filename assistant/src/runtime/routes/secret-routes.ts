import { setSecureKey } from '../../security/secure-keys.js';
import { upsertCredentialMetadata } from '../../tools/credentials/metadata-store.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('runtime-http');

export async function handleAddSecret(req: Request): Promise<Response> {
  const body = await req.json() as {
    service?: string;
    field?: string;
    value?: string;
    allowedTools?: string[];
    allowedDomains?: string[];
    usageDescription?: string;
  };

  const { service, field, value, allowedTools, allowedDomains, usageDescription } = body;

  if (!service || typeof service !== 'string') {
    return Response.json({ error: 'service is required' }, { status: 400 });
  }
  if (!field || typeof field !== 'string') {
    return Response.json({ error: 'field is required' }, { status: 400 });
  }
  if (!value || typeof value !== 'string') {
    return Response.json({ error: 'value is required' }, { status: 400 });
  }

  try {
    const key = `credential:${service}:${field}`;
    const stored = setSecureKey(key, value);
    if (!stored) {
      return Response.json({ error: 'Failed to store secret in secure storage' }, { status: 500 });
    }

    upsertCredentialMetadata(service, field, {
      allowedTools,
      allowedDomains,
      usageDescription,
    });

    log.info({ service, field }, 'Secret added via HTTP');
    return Response.json({ success: true, service, field }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, service, field }, 'Failed to add secret via HTTP');
    return Response.json({ error: message }, { status: 500 });
  }
}
