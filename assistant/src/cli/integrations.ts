// Re-export barrel — keeps existing `from "./integrations.js"` imports working
// under NodeNext module resolution, which does not resolve directory indices
// from bare `.js` imports.
export {
  gatewayGet,
  gatewayPost,
  registerIntegrationsCommand,
  runRead,
  shouldOutputJson,
  toQueryString,
  writeOutput,
} from "./integrations/index.js";
