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
