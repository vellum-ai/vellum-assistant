"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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

interface PortalContainers {
  navbar: HTMLElement | null;
  hero: HTMLElement | null;
  logo: HTMLElement | null;
  automate: HTMLElement | null;
  trigger: HTMLElement | null;
  videoIntro: HTMLElement | null;
  buildAction: HTMLElement | null;
  agents: HTMLElement | null;
  prompt: HTMLElement | null;
  arc: HTMLElement | null;
  prompts: HTMLElement | null;
  workflowCta: HTMLElement | null;
}

const INITIAL_CONTAINERS: PortalContainers = {
  navbar: null,
  hero: null,
  logo: null,
  automate: null,
  trigger: null,
  videoIntro: null,
  buildAction: null,
  agents: null,
  prompt: null,
  arc: null,
  prompts: null,
  workflowCta: null,
};

const SECTION_SELECTORS: Array<{ key: keyof PortalContainers; selector: string }> = [
  { key: "navbar", selector: "#w-node-_45f8248c-ee2e-e6a9-2792-1d703651d480-3651d355" },
  { key: "hero", selector: ".section_home.home" },
  { key: "logo", selector: ".section-logo.new" },
  { key: "automate", selector: ".section_automate" },
  { key: "trigger", selector: ".scetion_trigger" },
  { key: "videoIntro", selector: ".section_video-intro" },
  { key: "buildAction", selector: ".section_build-action" },
  { key: "agents", selector: ".section_agents" },
  { key: "prompt", selector: ".section_prompt" },
  { key: "arc", selector: ".section_arc" },
  { key: "prompts", selector: ".section_prompts" },
  { key: "workflowCta", selector: ".section_workflow-cta" },
];

export function VellumBody() {
  const [bodyHTML, setBodyHTML] = useState<string>("");
  const [containers, setContainers] = useState<PortalContainers>(INITIAL_CONTAINERS);

  useEffect(() => {
    fetch("/vellum-homepage.html")
      .then((res) => res.text())
      .then((html) => {
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        if (bodyMatch && bodyMatch[1]) {
          let bodyContent = bodyMatch[1];

          bodyContent = bodyContent.replace(
            /href="https:\/\/app\.vellum\.ai\/signup"/g,
            'href="/signup"'
          );
          bodyContent = bodyContent.replace(
            /href="https:\/\/app\.vellum\.ai"(?![^<]*signup)/g,
            'href="/login"'
          );
          bodyContent = bodyContent.replace(
            /https:\/\/app\.vellum\.ai\/onboarding\/agent-builder\/signup/g,
            "/signup"
          );

          setBodyHTML(bodyContent);
        }
      })
      .catch((err) => {
        console.error("Failed to load Vellum homepage:", err);
      });
  }, []);

  useEffect(() => {
    if (!bodyHTML) {
      return;
    }

    setTimeout(() => {
      const next: PortalContainers = { ...INITIAL_CONTAINERS };

      for (const { key, selector } of SECTION_SELECTORS) {
        const el = document.querySelector(selector);
        if (el) {
          el.innerHTML = "";
          next[key] = el as HTMLElement;
        }
      }

      setContainers(next);
    }, 0);
  }, [bodyHTML]);

  if (!bodyHTML) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: bodyHTML }} />
      {containers.navbar && createPortal(<NavBar />, containers.navbar)}
      {containers.hero && createPortal(<HeroSection />, containers.hero)}
      {containers.logo && createPortal(<LogoMarquee />, containers.logo)}
      {containers.automate && createPortal(<AutomateSection />, containers.automate)}
      {containers.trigger && createPortal(<TriggerCards />, containers.trigger)}
      {containers.videoIntro && createPortal(<VideoIntro />, containers.videoIntro)}
      {containers.buildAction && createPortal(<BuildAction />, containers.buildAction)}
      {containers.agents && createPortal(<AgentsSection />, containers.agents)}
      {containers.prompt && createPortal(<PromptSection />, containers.prompt)}
      {containers.arc && createPortal(<ArcSection />, containers.arc)}
      {containers.prompts && createPortal(<PromptsGrid />, containers.prompts)}
      {containers.workflowCta && createPortal(<WorkflowCTA />, containers.workflowCta)}
    </>
  );
}
