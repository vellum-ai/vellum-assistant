import { API_KEY_PROVIDERS, invalidateConfigCache } from '../../config/loader.js';
import { setSecureKey } from '../../security/secure-keys.js';
import { assertMetadataWritable, upsertCredentialMetadata } from '../../tools/credentials/metadata-store.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('runtime-http');

export async function handleAddSecret(req: Request): Promise<Response> {
  const body = await req.json() as {
    type?: string;
    name?: string;
    value?: string;
  };

  const { type, name, value } = body;

  if (!type || typeof type !== 'string') {
    return Response.json({ error: 'type is required' }, { status: 400 });
  }
  if (!name || typeof name !== 'string') {
    return Response.json({ error: 'name is required' }, { status: 400 });
  }
  if (!value || typeof value !== 'string') {
    return Response.json({ error: 'value is required' }, { status: 400 });
  }

  try {
    if (type === 'api_key') {
      if (!API_KEY_PROVIDERS.includes(name as typeof API_KEY_PROVIDERS[number])) {
        return Response.json(
          { error: `Unknown API key provider: ${name}. Valid providers: ${API_KEY_PROVIDERS.join(', ')}` },
          { status: 400 },
        );
      }
      const stored = setSecureKey(name, value);
      if (!stored) {
        return Response.json({ error: 'Failed to store API key in secure storage' }, { status: 500 });
      }
      invalidateConfigCache();
      log.info({ provider: name }, 'API key updated via HTTP');
      return Response.json({ success: true, type, name }, { status: 201 });
    }

    if (type === 'credential') {
      const colonIdx = name.indexOf(':');
      if (colonIdx < 1 || colonIdx === name.length - 1) {
        return Response.json(
          { error: 'For credential type, name must be in "service:field" format (e.g. "github:api_token")' },
          { status: 400 },
        );
      }
      assertMetadataWritable();
      const service = name.slice(0, colonIdx);
      const field = name.slice(colonIdx + 1);
      const key = `credential:${service}:${field}`;
      const stored = setSecureKey(key, value);
      if (!stored) {
        return Response.json({ error: 'Failed to store credential in secure storage' }, { status: 500 });
      }
      upsertCredentialMetadata(service, field, {});
      log.info({ service, field }, 'Credential added via HTTP');
      return Response.json({ success: true, type, name }, { status: 201 });
    }

    return Response.json(
      { error: `Unknown secret type: ${type}. Valid types: api_key, credential` },
      { status: 400 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, type, name }, 'Failed to add secret via HTTP');
    return Response.json({ error: message }, { status: 500 });
  }
}
