"use client";

import { WorkflowCTA } from "@/components/marketing/VellumHomepage/WorkflowCTA";

import { CommunityHero } from "./_CommunityHero";
import { CommunityPrompts } from "./_CommunityPrompts";
import { FullNavBar } from "./_FullNavBar";

export function CommunityBody() {
  return (
    <>
      <FullNavBar />
      <CommunityHero />
      <CommunityPrompts />
      <WorkflowCTA />
    </>
  );
}
