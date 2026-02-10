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
      {/* Hero wrapper - always 100vh */}
      <div
        style={{
          height: "100vh",
          minHeight: "100vh",
          backgroundImage: "url('/hero-bg.jpg')",
          backgroundSize: "auto 100%",
          backgroundPosition: "center bottom",
          backgroundRepeat: "no-repeat",
          backgroundColor: "#3a8bc2",
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <NavBar />
        <HeroSection />
        <LogoMarquee />
      </div>
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
