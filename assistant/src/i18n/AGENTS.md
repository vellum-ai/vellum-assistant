# Daemon i18n

User-facing copy that the assistant persists or emits (HTTP, CLI, channels)
goes through `assistant/src/i18n/`. The web app has its own catalogs; this
module is for constants the daemon stores or serializes.

## Rules

1. Add a key to `MESSAGE_KEYS` and to every locale in `MESSAGE_CATALOGS`.
2. Persist the key, or the English default when a column already stores
   English. Never persist a translated string.
3. Resolve with `t(key, locale)` at the edge that emits the string.
4. Classify stored values with `messageKeyFromStored` / a typed helper
   (`classifyConversationTitle`). Do not match English copy at each
   call site.
5. Locale comes from `Accept-Language` (`localeFromAcceptLanguage`) or
   an explicit CLI flag. Missing locale is `en`.

Conversation titles are the first consumer: the title column still stores
the English placeholders (`Generating title...`, `Untitled Conversation`)
so existing replaceability checks and older clients keep working. The
English catalog entries for those keys must match the stored placeholders
so a missing `Accept-Language` keeps the same title bytes. The serializer
emits `titleState` so clients can localize from their own catalogs without
sniffing those strings.
