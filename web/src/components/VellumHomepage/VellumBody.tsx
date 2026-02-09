import { AgentsSection } from "./AgentsSection";
import { ArcSection } from "./ArcSection";
import { AutomateSection } from "./AutomateSection";
import { BuildAction } from "./BuildAction";
import { HeroSection } from "./HeroSection";
import { LogoMarquee } from "./LogoMarquee";
import { NavBar } from "./NavBar";
import { PromptSection } from "./PromptSection";
import { PromptsGrid } from "./PromptsGrid";
import { TriggerCards } from "./TriggerCards";
import { VideoIntro } from "./VideoIntro";
import { WorkflowCTA } from "./WorkflowCTA";
import { getTemplatesForHomepage } from "@/lib/template-content";

export function VellumBody() {
  // Fetch templates for each category
  const templatesByCategory = getTemplatesForHomepage();

  return (
    <>
      <NavBar />
      <HeroSection templatesByCategory={templatesByCategory} />
      <LogoMarquee />
      <AutomateSection />
      <TriggerCards />
      <VideoIntro />
      <BuildAction />
      <AgentsSection />
      <PromptSection />
      <ArcSection />
      <PromptsGrid />
      <WorkflowCTA />
    </>
  );
}
