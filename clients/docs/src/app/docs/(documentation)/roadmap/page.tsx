import { RoadmapContent } from "@/app/docs/_components/roadmap-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Roadmap - Vellum Docs",
  description:
    "What's coming to Vellum — shipping soon, up next, on the horizon, and what we're exploring.",
  path: "/docs/roadmap",
});

export default function RoadmapPage() {
  return <RoadmapContent />;
}
