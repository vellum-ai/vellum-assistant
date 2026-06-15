import { AssistantClient } from "./assistant-client.js";

export const WEB_REMOTE_INGRESS_FLAG = "web-remote-ingress";

type FeatureFlagEntry = {
  key?: unknown;
  enabled?: unknown;
};

type FeatureFlagsResponse = {
  flags?: FeatureFlagEntry[];
};

export async function isAssistantFeatureFlagEnabled(
  assistantId: string,
  key: string,
): Promise<boolean> {
  const client = new AssistantClient({ assistantId });
  const res = await client.get("/feature-flags");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to fetch feature flags: HTTP ${res.status} ${body}`.trim(),
    );
  }

  const data = (await res.json()) as FeatureFlagsResponse;
  const flag = data.flags?.find((entry) => entry.key === key);
  return flag?.enabled === true;
}

export function formatFeatureFlagGateMessage(flagKey: string): string {
  return `This command is behind the \`${flagKey}\` feature flag. Enable it with \`vellum flags set ${flagKey} true\` and try again.`;
}
