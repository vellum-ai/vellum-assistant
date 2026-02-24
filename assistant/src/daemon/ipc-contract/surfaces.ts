// Surface types, UI surface lifecycle messages.

// === Surface type definitions ===

export type SurfaceType = 'card' | 'form' | 'list' | 'table' | 'confirmation' | 'dynamic_page' | 'file_upload' | 'browser_view' | 'document_preview';

export const INTERACTIVE_SURFACE_TYPES: SurfaceType[] = ['form', 'confirmation', 'dynamic_page', 'file_upload'];

export interface SurfaceAction {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'destructive';
}

export interface CardSurfaceData {
  title: string;
  subtitle?: string;
  body: string;
  metadata?: Array<{ label: string; value: string }>;
  /** Optional template name for specialized rendering (e.g. "weather_forecast"). */
  template?: string;
  /** Arbitrary data consumed by the template renderer. Shape depends on template. */
  templateData?: Record<string, unknown>;
}

export interface FormField {
  id: string;
  type: 'text' | 'textarea' | 'select' | 'toggle' | 'number' | 'password';
  label: string;
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | number | boolean;
  options?: Array<{ label: string; value: string }>;
}

export interface FormPage {
  id: string;
  title: string;
  description?: string;
  fields: FormField[];
}

export interface FormSurfaceData {
  description?: string;
  fields: FormField[];
  submitLabel?: string;
  pages?: FormPage[];
  pageLabels?: { next?: string; back?: string; submit?: string };
}

export interface ListItem {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  selected?: boolean;
}

export interface ListSurfaceData {
  items: ListItem[];
  selectionMode: 'single' | 'multiple' | 'none';
}

export interface ConfirmationSurfaceData {
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface DynamicPagePreview {
  title: string;
  subtitle?: string;
  description?: string;
  icon?: string;
  metrics?: Array<{ label: string; value: string }>;
}

export interface DynamicPageSurfaceData {
  html: string;
  width?: number;
  height?: number;
  appId?: string;
  appType?: string;
  reloadGeneration?: number;
  status?: string;
  preview?: DynamicPagePreview;
}

export interface FileUploadSurfaceData {
  prompt: string;
  acceptedTypes?: string[];
  maxFiles?: number;
  maxSizeBytes?: number;
}

export interface TableColumn {
  id: string;
  label: string;
  width?: number;
}

export interface TableRow {
  id: string;
  cells: Record<string, string>;
  selectable?: boolean;
  selected?: boolean;
}

export interface TableSurfaceData {
  columns: TableColumn[];
  rows: TableRow[];
  selectionMode?: 'none' | 'single' | 'multiple';
  caption?: string;
}

export interface BrowserViewSurfaceData {
  sessionId: string;
  currentUrl: string;
  status: 'navigating' | 'idle' | 'interacting';
  frame?: string; // base64 JPEG
  actionText?: string; // "Clicking 'Submit' button"
  highlights?: Array<{ x: number; y: number; w: number; h: number; label: string }>;
  pages?: Array<{ id: string; title: string; url: string; active: boolean }>;
}

export interface DocumentPreviewSurfaceData {
  title: string;
  surfaceId: string;   // the doc's real surfaceId, for focusing the panel
  subtitle?: string;
}

export type SurfaceData = CardSurfaceData | FormSurfaceData | ListSurfaceData | TableSurfaceData | ConfirmationSurfaceData | DynamicPageSurfaceData | FileUploadSurfaceData | BrowserViewSurfaceData | DocumentPreviewSurfaceData;

// === Client → Server ===

export interface UiSurfaceAction {
  type: 'ui_surface_action';
  sessionId: string;
  surfaceId: string;
  actionId: string;
  data?: Record<string, unknown>;
}

export interface UiSurfaceUndoRequest {
  type: 'ui_surface_undo';
  sessionId: string;
  surfaceId: string;
}

// === Server → Client ===

/** Common fields shared by all UiSurfaceShow variants. */
interface UiSurfaceShowBase {
  type: 'ui_surface_show';
  sessionId: string;
  surfaceId: string;
  title?: string;
  actions?: SurfaceAction[];
  display?: 'inline' | 'panel';
  /** The message ID that this surface belongs to (for history loading). */
  messageId?: string;
}

export interface UiSurfaceShowCard extends UiSurfaceShowBase {
  surfaceType: 'card';
  data: CardSurfaceData;
}

export interface UiSurfaceShowForm extends UiSurfaceShowBase {
  surfaceType: 'form';
  data: FormSurfaceData;
}

export interface UiSurfaceShowList extends UiSurfaceShowBase {
  surfaceType: 'list';
  data: ListSurfaceData;
}

export interface UiSurfaceShowConfirmation extends UiSurfaceShowBase {
  surfaceType: 'confirmation';
  data: ConfirmationSurfaceData;
}

export interface UiSurfaceShowDynamicPage extends UiSurfaceShowBase {
  surfaceType: 'dynamic_page';
  data: DynamicPageSurfaceData;
}

export interface UiSurfaceShowTable extends UiSurfaceShowBase {
  surfaceType: 'table';
  data: TableSurfaceData;
}

export interface UiSurfaceShowFileUpload extends UiSurfaceShowBase {
  surfaceType: 'file_upload';
  data: FileUploadSurfaceData;
}

export interface UiSurfaceShowBrowserView extends UiSurfaceShowBase {
  surfaceType: 'browser_view';
  data: BrowserViewSurfaceData;
}

export interface UiSurfaceShowDocumentPreview extends UiSurfaceShowBase {
  surfaceType: 'document_preview';
  data: DocumentPreviewSurfaceData;
}

export type UiSurfaceShow =
  | UiSurfaceShowCard
  | UiSurfaceShowForm
  | UiSurfaceShowList
  | UiSurfaceShowTable
  | UiSurfaceShowConfirmation
  | UiSurfaceShowDynamicPage
  | UiSurfaceShowFileUpload
  | UiSurfaceShowBrowserView
  | UiSurfaceShowDocumentPreview;

export interface UiSurfaceUpdate {
  type: 'ui_surface_update';
  sessionId: string;
  surfaceId: string;
  data: Partial<SurfaceData>;
}

export interface UiSurfaceDismiss {
  type: 'ui_surface_dismiss';
  sessionId: string;
  surfaceId: string;
}

export interface UiSurfaceComplete {
  type: 'ui_surface_complete';
  sessionId: string;
  surfaceId: string;
  summary: string;
  submittedData?: Record<string, unknown>;
}

export interface UiSurfaceUndoResult {
  type: 'ui_surface_undo_result';
  sessionId: string;
  surfaceId: string;
  success: boolean;
  /** Number of remaining undo entries after this undo. */
  remainingUndos: number;
}
