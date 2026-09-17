# Conversation assets

The conversation header and Chat Info panel read apps, documents, attachments,
and camera frames from the request-scoped TanStack Query cache. The scope changes
with the authenticated user or organization. The hooks derive display state from
that cache; they do not keep a second copy of server data.

`useConversationAttachments` owns the independent, paginated file and camera-frame
queries. `useConversationAssets` combines these with apps and documents. Documents
and ordinary attachments share the Files category but retain separate loading and
failure states. A failed source cannot discard another source's results.

The header and each category distinguish complete totals from incomplete or
cached results. A background refresh failure preserves cached assets and names
the failed refresh. Retry belongs to the hook that owns the query and targets
the failed source or next page, preserving successful cache entries and selection.
Pending queries and failed queries are never presented as successful empty lists.

Older assistants and confirmed missing attachment-list routes use attachments
from loaded conversation history. Those counts describe loaded history only;
camera-frame classification is unavailable on that path. Authorization failures,
405 responses, and server errors do not enable the compatibility fallback.

The platform exposes attachment collection GET requests through its authenticated
runtime proxy. POST retains its upload handler. DELETE routing and attachment
cleanup are separate concerns.

## Diagnostics

The request-scoped query provider installs one asset-query observer once the
authentication session settles. Saved events survive a same-user reload while
the session probe is pending. The observer records terminal failures and
subsequent recoveries in the bounded lifecycle diagnostic ring. Multiple
consumers of the same query do not create duplicate events.

Support archives include `web-asset-diagnostics.json`, a current snapshot from
the same scoped cache used by the UI. Fields are allowlisted: source, endpoint
template, supported filters and pagination, scoped identifiers, status and error
category, retry state, and cached-data availability. Request bodies, response
bodies, credentials, filenames, and file contents are excluded. Collection is
best-effort, and changing user or organization clears prior asset events.

Pagination diagnostics include loaded offsets and the requested offset for an
initial load or next page. A multi-page refresh can fail on any loaded page, so
its failed offset is recorded as unknown. The existing error path does not retain
upstream request IDs; diagnostics do not infer one from error text or bodies.

These queries use existing retry and reconnect policies. The feature adds no
background polling or persistent server data.
