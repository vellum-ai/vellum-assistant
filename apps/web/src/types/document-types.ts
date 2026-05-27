import type {
  DocumentsByIdGetResponse,
  DocumentsGetResponse,
} from "@/generated/daemon/types.gen";

export type DocumentSummary = DocumentsGetResponse["documents"][number];

export type DocumentContent = DocumentsByIdGetResponse;
