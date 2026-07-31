import { ModelProfilesContent } from "@/app/docs/_components/model-profiles-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Model Profiles - Vellum Docs",
  description:
    "Control which LLM model and settings your assistant uses for each job — conversations, memory, background tasks — and optimize token costs with profiles and call-site overrides.",
  path: "/docs/key-concepts/model-profiles",
});

export default function ModelProfilesPage() {
  return <ModelProfilesContent />;
}
