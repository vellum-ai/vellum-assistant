# Classification Provider Onboarding

The classification family serves decision models: a provider that answers a
question about some input with structured output (a probability, a choice, a
score) rather than generated chat text. It is configured through
`services.classification` and read directly by its consumers, so a
classification model never appears in text pickers and cannot back an
inference profile.

Today's only provider is TypeSafe (System One, model `jev-latest`).

## Where it lives

| Concern        | File                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| Catalog        | `src/providers/classification/provider-catalog.ts`                                           |
| Config schema  | `src/config/schemas/classification.ts`                                                       |
| Resolver       | `src/providers/classification/resolve.ts`                                                    |
| Client         | `src/providers/jev/client.ts`                                                                |
| Settings route | `src/runtime/routes/classification-routes.ts`                                                |
| Consumers      | `src/calls/typesafe-noul.ts` (voice judges), `src/plugins/defaults/memory/v3/pool-select.ts` |

## Config

```json
{
  "services": {
    "classification": {
      "mode": "your-own",
      "provider": "typesafe",
      "model": "jev-latest"
    }
  }
}
```

- `mode: "your-own"` reads the provider's stored API key (credential name
  from the catalog entry's `credentialProvider`, env var fallback from its
  `envVar`).
- `mode: "managed"` routes through the platform runtime proxy at the entry's
  `managedProxyPath` with the assistant API key, so the org is billed. The
  platform must front the provider (see the platform repo's runtime-proxy
  registry) before this works.

The family is inert until one of those resolves. Consumers treat "no
provider" as "keep the default behavior": the voice escalation and
continuation judges stay off, and the memory pool selector uses its LLM call
site.

## Adding a provider

1. Add a `ClassificationProviderEntry` to the catalog. `credentialProvider`
   and `envVar` feed the secret catalog and the env-var fallback
   automatically. Set `managedProxyPath` only once the platform serves the
   provider.
2. Extend `ClassificationProviderId` and add a case to
   `buildClassificationProvider` in `resolve.ts`; the exhaustive switch
   fails to compile until you do.
3. Mirror the env var in `cli/src/shared/provider-env-vars.ts`
   (`CLASSIFICATION_PROVIDER_ENV_VAR_NAMES`); the CLI does not import the
   daemon catalog.
4. If the provider needs key validation on save, add a branch in
   `src/runtime/routes/secret-routes.ts` next to the TypeSafe one.
5. Run `bun run generate:openapi` so the settings route's client metadata
   reaches the web catalog.
