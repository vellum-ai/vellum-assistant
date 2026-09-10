// The web reads the shared predicate, the same one the TUI and the plain
// CLI decide by, so no two consumers can disagree on whether an error ends a
// turn.
export { isMessageScopedError } from "@vellumai/service-contracts/message-scoped-error";
