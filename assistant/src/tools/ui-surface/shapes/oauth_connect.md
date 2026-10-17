# oauth_connect

managed OAuth connection button for an integration account

```
{ providerKey, requestedScopes?, displayName?, description?, logoUrl? }: managed OAuth connection CTA; use when the task needs a managed integration account (Google, Linear, GitHub, ...) instead of settings or shell OAuth. requestedScopes is an optional FULL replacement set of OAuth scopes: when set, the connection is granted exactly these scopes instead of the platform defaults, so include every scope the connection should keep; omit it to use the platform's default scopes
```
