// Document editor events.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file only composes them into the domain union consumed by
// `message-protocol.ts`. Document save/load/list are served by the document
// tools and HTTP document routes, not by client messages.

import type { DocumentEditorShowEvent } from "../../api/events/document-editor-show.js";
import type { DocumentEditorUpdateEvent } from "../../api/events/document-editor-update.js";

export type _DocumentsServerMessages =
  | DocumentEditorShowEvent
  | DocumentEditorUpdateEvent;
