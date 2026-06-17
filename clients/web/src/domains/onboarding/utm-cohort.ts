import { client } from "@/generated/api/client.gen";

const UTM_CAMPAIGN_TO_COHORT: Record<string, string> = {
  "content-automation": "content-automation",
};

interface UserMeWithAttribution {
  marketing_attribution?: { utm_campaign?: string };
}

export async function resolveUserCohort(): Promise<string | null> {
  try {
    const { data, response } = await client.get<UserMeWithAttribution, unknown>({
      url: "/v1/user/me/",
      throwOnError: false,
    });

    if (!response?.ok || !data) return null;

    const campaign = (data as UserMeWithAttribution).marketing_attribution
      ?.utm_campaign;
    if (typeof campaign === "string" && campaign) {
      return UTM_CAMPAIGN_TO_COHORT[campaign] ?? null;
    }
  } catch {
    // Network error or unauthenticated — degrade to default flow.
  }
  return null;
}
