import { getCliLogger } from "../util/logger.js";

/** Shared CLI logger instance. Most commands use this directly. */
export const log = getCliLogger("cli");

export { getCliLogger } from "../util/logger.js";
