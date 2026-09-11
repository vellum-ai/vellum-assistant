import { AsyncLocalStorage } from "node:async_hooks";

const completionRequired = new AsyncLocalStorage<true>();

/** A mutation lock must remain held until its credential operation settles. */
export function withCredentialCompletion<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return completionRequired.run(true, operation);
}

export function requiresCredentialCompletion(): boolean {
  return completionRequired.getStore() === true;
}
