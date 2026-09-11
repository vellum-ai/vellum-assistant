import { documentsByIdGet } from "@/generated/daemon/sdk.gen";

import { waitForDocumentSaves, type DocumentSaveTarget } from "./document-save";

interface DocumentLoadOptions extends Pick<
  DocumentSaveTarget,
  "assistantId" | "surfaceId"
> {
  isCurrent: () => boolean;
}

/** Reads persisted content after local editor writes, only for a current owner. */
export async function loadDocumentContent({
  assistantId,
  surfaceId,
  isCurrent,
}: DocumentLoadOptions) {
  await waitForDocumentSaves({ assistantId, surfaceId }, isCurrent);
  if (!isCurrent()) {
    return null;
  }
  const { data } = await documentsByIdGet({
    path: { assistant_id: assistantId, id: surfaceId },
    throwOnError: true,
  });
  return isCurrent() ? data : null;
}
