import type { OAuthConnection } from "@/generated/api/types.gen";

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function providerConnectionSignature(
  connection: OAuthConnection,
): string {
  return JSON.stringify({
    status: connection.status,
    connected: connection.connected,
    account_label: connection.account_label,
    scopes_granted: [...connection.scopes_granted].sort(),
    expires_at: connection.expires_at,
  });
}

export function getProviderConnectionSignatures(
  connections: readonly OAuthConnection[] | undefined,
  providerKey: string,
): Map<string, string> {
  return new Map(
    (connections ?? [])
      .filter((connection) => connection.provider === providerKey)
      .map((connection) => [
        connection.id,
        providerConnectionSignature(connection),
      ]),
  );
}

export function hasNewOrChangedProviderConnection(
  connections: readonly OAuthConnection[],
  providerKey: string,
  baselineSignatures: ReadonlyMap<string, string>,
): boolean {
  return connections.some(
    (connection) =>
      connection.provider === providerKey &&
      connection.connected &&
      baselineSignatures.get(connection.id) !==
        providerConnectionSignature(connection),
  );
}

export function findNewOrChangedProviderConnection(
  connections: readonly OAuthConnection[],
  providerKey: string,
  baselineSignatures: ReadonlyMap<string, string>,
): OAuthConnection | null {
  return (
    connections.find(
      (connection) =>
        connection.provider === providerKey &&
        connection.connected &&
        baselineSignatures.get(connection.id) !==
          providerConnectionSignature(connection),
    ) ?? null
  );
}
