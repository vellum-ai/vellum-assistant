/**
 * Backwards-compat gate: creating a blank document from the web app.
 *
 * `POST /v1/documents/create` mints a document's surface ID on the assistant
 * and returns the new document. Assistants without the route 404 it, so the
 * web app hides every "New document" action: the conversation menu and the
 * Library render exactly as they did before the feature, with nothing to
 * invoke and no error surfaced. Documents on those assistants are still
 * created by the assistant's own `document_create` tool.
 *
 * A render hook (not the `assistantSupports` snapshot) so the actions appear
 * the moment the version hydrates.
 *
 * MIN_VERSION is the dev floor of the commit that added the route (#43069),
 * stamped with that commit's UTC minute and short sha.
 */
import { useAssistantSupports } from "@/lib/backwards-compat/utils";

const MIN_VERSION = "0.12.2-dev.202609211450.3151b18";

export function useSupportsDocumentCreate(): boolean {
  return useAssistantSupports(MIN_VERSION);
}
