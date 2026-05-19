/**
 * Perception spine startup.
 *
 * Creates the process-wide `ContextBuffer` and attaches it to the shared
 * `assistantEventHub` when the `perception` feature flag is on. A no-op
 * when the flag is off, so calling this unconditionally from daemon
 * startup is safe.
 *
 * Per the daemon-startup philosophy (see `assistant/AGENTS.md`), this
 * module must never throw. Failures are logged and the perception buffer
 * is left null, so the rest of the daemon keeps running.
 *
 * Roadmap: `docs/jarvis-roadmap.md`.
 */

import { getConfig } from "../config/loader.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import { ContextBuffer } from "./context-buffer.js";
import { isPerceptionEnabled } from "./feature-gate.js";
import { PerceptionInterpreter } from "./interpreter.js";
import { PersonalKnowledgeWriter } from "./personal-knowledge-writer.js";
import { PerceptionRelevanceGate } from "./relevance-gate.js";

const log = getLogger("perception-startup");

let active: ContextBuffer | null = null;
let activeInterpreter: PerceptionInterpreter | null = null;
let activeRelevanceGate: PerceptionRelevanceGate | null = null;
let activePersonalKnowledgeWriter: PersonalKnowledgeWriter | null = null;

/**
 * Initialise the perception spine. Safe to call multiple times; subsequent
 * calls are no-ops once the buffer is attached.
 */
export function startPerception(): void {
  if (active) return;
  try {
    const config = getConfig();
    if (!isPerceptionEnabled(config)) {
      log.debug("perception flag off; skipping startup");
      return;
    }
  } catch (err) {
    log.warn({ err }, "failed to read config; perception not started");
    return;
  }

  try {
    const buffer = new ContextBuffer();
    buffer.attach(assistantEventHub);
    active = buffer;
    const interpreter = new PerceptionInterpreter();
    interpreter.attach(assistantEventHub);
    activeInterpreter = interpreter;
    const relevanceGate = new PerceptionRelevanceGate();
    relevanceGate.attach(assistantEventHub);
    activeRelevanceGate = relevanceGate;
    const personalKnowledgeWriter = new PersonalKnowledgeWriter();
    personalKnowledgeWriter.attach(assistantEventHub);
    activePersonalKnowledgeWriter = personalKnowledgeWriter;
    log.info("perception spine started");
  } catch (err) {
    log.warn({ err }, "perception spine failed to start");
  }
}

/**
 * Return the active perception buffer, or `null` if the feature is off or
 * startup hasn't run yet. Consumers (future IPC routes, tools) must handle
 * the null case rather than assume the buffer exists.
 */
export function getPerceptionBuffer(): ContextBuffer | null {
  return active;
}

/**
 * Tear down the perception spine. Used by tests and shutdown handlers.
 */
export function stopPerception(): void {
  activePersonalKnowledgeWriter?.detach();
  activePersonalKnowledgeWriter = null;
  activeRelevanceGate?.detach();
  activeRelevanceGate = null;
  activeInterpreter?.detach();
  activeInterpreter = null;
  if (!active) return;
  active.detach();
  active = null;
}
