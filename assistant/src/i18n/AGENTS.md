# Daemon i18n

User-facing copy the assistant generates as a hardcoded constant goes
through `assistant/src/i18n/`. The web app has its own catalogs. This
module is for constants the daemon writes or emits.

## Rules

1. Add a key to `MESSAGE_KEYS` and to every locale in `MESSAGE_CATALOGS`.
2. Persist the key when a column holds a system constant. Never persist a
   translated string.
3. Resolve with `t(key, locale)` or a typed helper (`resolveConversationTitle`)
   at the edge that emits the string.
4. Do not match stored display strings back to keys. A stored title may be
   in any language on purpose.
5. Locale comes from `Accept-Language` (`localeFromAcceptLanguage`) or an
   explicit CLI flag. Default `en` lives in this module, not at each caller.

Conversation titles persist `conversation.title.generating` /
`conversation.title.untitled`. `resolveConversationTitle` turns those keys
into catalog copy. Legacy English placeholders stay replaceable via the
title service patterns and pass through on the wire until they are retitled.
