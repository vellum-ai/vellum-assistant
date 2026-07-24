// App management, publishing, and sharing.
//
// Server→client events that are live hub broadcasts are single-sourced from
// their canonical `api/events` wire schemas; this file only composes them into
// the domain union consumed by `message-protocol.ts`. App management — listing,
// bundling, sharing, publishing, history/diff/restore, signing — is served by
// the HTTP app-management routes, not by client messages.

import type { AppFilesChangedEvent } from "../../api/events/app-files-changed.js";

export type _AppsServerMessages = AppFilesChangedEvent;
