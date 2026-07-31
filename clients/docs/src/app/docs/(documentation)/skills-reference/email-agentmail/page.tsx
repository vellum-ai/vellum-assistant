import { SkillsReferenceEmailAgentMailContent } from "@/app/docs/_components/skills-reference-email-agent-mail-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Email (AgentMail) - Vellum Docs",
  description:
    "Email skill for Vellum — send, read, search, and manage email from your assistant's own address.",
  path: "/docs/skills-reference/email-agentmail",
});

export default function SkillsReferenceEmailAgentMailPage() {
  return <SkillsReferenceEmailAgentMailContent />;
}
