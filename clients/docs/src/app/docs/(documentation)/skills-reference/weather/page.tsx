import { SkillsReferenceWeatherContent } from "@/app/docs/_components/skills-reference-weather-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Weather - Vellum Docs",
  description:
    "Weather skill for Vellum: get current conditions and forecasts for any location.",
  path: "/docs/skills-reference/weather",
});

export default function SkillsReferenceWeatherPage() {
  return <SkillsReferenceWeatherContent />;
}
