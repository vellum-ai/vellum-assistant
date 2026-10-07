# App publishing

Publishing an app compiles it to a single self-contained HTML document and
hands that document to a **publish provider**, which returns the public URL the
app is served from plus an opaque deployment id. Vercel is the shipped default;
a self-hoster can point publishing at their own platform.

The code lives in [`src/services/publish/`](../src/services/publish/):
`types.ts` is the contract, `registry.ts` selects the provider and wraps every
call in the credential broker, and one file per provider implements it. The
routes are `src/runtime/routes/publish-routes.ts`.

## Configuration

```jsonc
{
  "apps": {
    "publish": {
      "provider": "vercel", // or "webhook"
      "webhook": {
        "url": "",
        "unpublishUrl": "",
        "unpublishMethod": "DELETE",
        "timeoutMs": 60000,
      },
    },
  },
}
```

Every leaf falls back to its default rather than failing the config load, so an
unknown `provider` or a mistyped `timeoutMs` degrades to Vercel / 60s instead of
quarantining `config.json`.

Credentials never live in config. Each provider names the credential-store
entry it authenticates with, and the assistant reads it through the credential
broker so the plaintext never reaches the publish code.

| Provider  | Credential              | Required                                 |
| --------- | ----------------------- | ---------------------------------------- |
| `vercel`  | `vercel/api_token`      | yes                                      |
| `webhook` | `publish_webhook/token` | no (unset means an unauthenticated POST) |

The broker enforces per-credential tool policy, so a webhook token must allow
the `publish_page` and `unpublish_page` tools:

```bash
assistant credentials set --service publish_webhook --field token <value> \
  --allowed-tools "publish_page,unpublish_page"
```

## The webhook provider

`webhook` POSTs JSON to `apps.publish.webhook.url`. It is the escape hatch for
anything the assistant has no first-party provider for (Coolify, Dokku, Fly,
Cloudflare, a plain static host): write a small shim that accepts this payload
and the assistant can target it.

Request:

```jsonc
POST <apps.publish.webhook.url>
Content-Type: application/json
Authorization: Bearer <publish_webhook/token>   // only when the token is stored

{
  "appId": "app-123",
  "name": "Budget Tracker",
  "slug": "budget-tracker",
  "previousDeploymentId": "dep-0", // null on a first publish
  "html": "<!doctype html>…"
}
```

The shim answers `2xx` with:

```json
{ "url": "https://budget-tracker.example.com", "deploymentId": "dep-1" }
```

Anything else (a non-2xx, a body that is not JSON, a body missing either field)
fails the publish, and the assistant reports the status and a truncated body
back to the client.

Unpublishing sends the same shape minus `html`, with the live `deploymentId`,
to `apps.publish.webhook.unpublishUrl` (falling back to `url`) using
`apps.publish.webhook.unpublishMethod`. A failed takedown leaves the local
record **active**: a record marked inactive while the page is still reachable
is the worse of the two divergences.

### Outbound address policy

The endpoint is validated before every request: it must be `http`/`https`, and
on a platform-hosted assistant it must not resolve to a private, loopback, or
cloud-metadata address. A self-hosted assistant runs on the user's own machine,
so `http://localhost:8080/publish` is an expected target there and is allowed.
This matches the rule on custom inference base URLs
(`runtime/routes/inference-provider-connection-routes.ts`).

Redirects are not followed. The check runs against the configured endpoint, so
following a 3xx would let that endpoint hand the request to an address the
check would have refused; a redirect is reported as an ordinary failure.

## Adding a provider

1. Implement `PublishProvider` in `src/services/publish/<name>-provider.ts`.
2. Add its id to `PUBLISH_PROVIDER_IDS` in `src/config/schemas/apps.ts`.
3. Register it in `PROVIDERS` in `src/services/publish/registry.ts`.

Clients need no change: `provider` and `providerName` come back on the publish,
unpublish, and publish-status responses, and the web app labels its affordances
from them.
