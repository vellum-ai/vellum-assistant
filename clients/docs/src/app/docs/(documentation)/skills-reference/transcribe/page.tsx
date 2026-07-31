import { SkillsReferenceTranscribeContent } from "@/app/docs/_components/skills-reference-transcribe-content";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "Transcribe - Vellum Docs",
  description:
    "Transcribe skill for Vellum: transcribes audio and video files using OpenAI Whisper or whisper.cpp.",
  path: "/docs/skills-reference/transcribe",
});

export default function SkillsReferenceTranscribePage() {
  return <SkillsReferenceTranscribeContent />;
}
