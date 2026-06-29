/**
 * Lightweight event emitter for contact mutations.
 *
 * Listeners (e.g. the guardian caches) register via {@link onContactChange} to
 * react to contact writes. {@link emitContactChange} also broadcasts
 * `contacts_changed` to every connected client so they refresh their view.
 */
import { EventEmitter } from "node:events";

import { broadcastMessage } from "../runtime/assistant-event-hub.js";

const emitter = new EventEmitter();

/** Register a listener for contact change events. Returns an unsubscribe function. */
export function onContactChange(listener: () => void): () => void {
  emitter.on("changed", listener);
  return () => {
    emitter.off("changed", listener);
  };
}

/** Emit a contact change event. Called after successful contact writes. */
export function emitContactChange(): void {
  emitter.emit("changed");
  broadcastMessage({ type: "contacts_changed" });
}
