// Document editor and document persistence types.

// === Server → Client ===

export interface DocumentEditorShow {
  type: "document_editor_show";
  conversationId: string;
  surfaceId: string;
  title: string;
  initialContent: string;
}

export interface DocumentEditorUpdate {
  type: "document_editor_update";
  conversationId: string;
  surfaceId: string;
  markdown: string;
  mode: string;
}

// === Client → Server ===

export interface DocumentSaveRequest {
  type: "document_save";
  surfaceId: string;
  conversationId: string;
  title: string;
  content: string;
  wordCount: number;
}

export interface DocumentLoadRequest {
  type: "document_load";
  surfaceId: string;
}

export interface DocumentListRequest {
  type: "document_list";
  conversationId?: string;
}

// === Server → Client ===

export interface DocumentSaveResponse {
  type: "document_save_response";
  surfaceId: string;
  success: boolean;
  error?: string;
}

export interface DocumentLoadResponse {
  type: "document_load_response";
  surfaceId: string;
  conversationId: string;
  title: string;
  content: string;
  wordCount: number;
  createdAt: number;
  updatedAt: number;
  success: boolean;
  error?: string;
}

export interface DocumentListResponse {
  type: "document_list_response";
  documents: Array<{
    surfaceId: string;
    conversationId: string;
    title: string;
    wordCount: number;
    createdAt: number;
    updatedAt: number;
  }>;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _DocumentsClientMessages =
  | DocumentSaveRequest
  | DocumentLoadRequest
  | DocumentListRequest;

export type _DocumentsServerMessages =
  | DocumentEditorShow
  | DocumentEditorUpdate
  | DocumentSaveResponse
  | DocumentLoadResponse
  | DocumentListResponse;
