export async function probeGatewayAuthState(): Promise<{
  authenticated: boolean;
  mode: string;
}> {
  const res = await fetch("/auth/state", { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Gateway auth probe failed: ${res.status}`);
  }
  return res.json();
}
