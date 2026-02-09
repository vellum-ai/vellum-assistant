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

export function VellumBody() {
  return (
    <>
      <NavBar />
      <HeroSection />
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
