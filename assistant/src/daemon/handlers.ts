// Re-export everything from the decomposed handler modules.
// This file exists for backwards compatibility — all imports from
// './handlers.js' continue to work without changes.
export {
  handleMessage,
  renderHistoryContent,
  mergeToolResults,
} from './handlers/index.js';

export type {
  HandlerContext,
  SessionCreateOptions,
  HistoryToolCall,
  HistorySurface,
  RenderedHistoryContent,
  ParsedHistoryMessage,
} from './handlers/index.js';
