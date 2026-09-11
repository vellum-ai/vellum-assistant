import { Mutex } from "../util/mutex.js";

const configWrites = new Mutex();

/** Serializes MCP configuration read-modify-write operations across awaits. */
export function withMcpConfigWrite<T>(operation: () => Promise<T>): Promise<T> {
  return configWrites.withLock(operation);
}
