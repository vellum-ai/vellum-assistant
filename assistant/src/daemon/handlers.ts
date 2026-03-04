// Re-export everything from the decomposed handler modules.
// This file exists for backwards compatibility — all imports from
// './handlers.js' continue to work without changes.
export type {
  HandlerContext,
  HistorySurface,
  HistoryToolCall,
  ParsedHistoryMessage,
  RenderedHistoryContent,
  SessionCreateOptions,
} from './handlers/index.js';
export {
  handleMessage,
  mergeToolResults,
  renderHistoryContent,
} from './handlers/index.js';
