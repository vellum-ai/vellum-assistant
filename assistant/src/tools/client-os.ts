import type { ClientOs } from "../channels/types.js";

export function supportsClientOs(
  supportedClientOs: readonly ClientOs[] | undefined,
  clientOs: ClientOs | undefined,
): boolean {
  return (
    clientOs === undefined ||
    supportedClientOs === undefined ||
    supportedClientOs.includes(clientOs)
  );
}
