"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "what-it-does", label: "What it does", level: 2 },
  { id: "setup-required", label: "Setup required", level: 2 },
  { id: "permissions", label: "Permissions", level: 2 },
  { id: "common-prompts", label: "Common prompts", level: 2 },
  { id: "configuration", label: "Configuration", level: 2 },
  { id: "tips-gotchas", label: "Tips & gotchas", level: 2 },
];

export function SkillsReferenceTranscribeContent() {
  return (
    <>
      <DocsContent title="Transcribe" breadcrumb="Docs / Skills Reference / Transcribe">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Transcribes audio and video files using OpenAI Whisper (cloud) or whisper.cpp (local).
            Fast, accurate speech-to-text.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            OpenAI API key for cloud mode, or whisper.cpp installed locally for free on-device
            transcription.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>OpenAI API key (cloud mode) or local whisper.cpp installation</li>
            <li>File access for media files</li>
          </ul>
        </section>

        <section id="common-prompts" className="mt-12">
          <SectionHeading id="common-prompts" level={2}>
            Common prompts
          </SectionHeading>
          <div className="mb-0 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    You say...
                  </th>
                  <th className="px-4 py-2 text-left text-sm font-medium text-zinc-500">
                    What happens
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Transcribe this meeting recording&rdquo;
                  </td>
                  <td className="px-3 py-2">Converts audio to text</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Transcribe this video locally&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Uses on-device whisper.cpp (free, private)
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Transcribe this podcast and summarize it&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Transcription plus AI summary
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="configuration" className="mt-12">
          <SectionHeading id="configuration" level={2}>
            Configuration
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              Two modes &mdash; cloud (OpenAI Whisper, ~$0.006/min, fast) or local (whisper.cpp,
              free, private, slower)
            </li>
            <li>Automatically extracts audio from video files</li>
            <li>Handles files over 25MB by splitting</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Cloud vs. local.</strong> Use cloud mode for speed, local mode for privacy
              (audio never leaves your machine).
            </li>
            <li>
              <strong>Large file handling.</strong> Large files are automatically split at the 25MB
              boundary.
            </li>
            <li>
              <strong>Video support.</strong> Video files have their audio extracted automatically
              &mdash; no need to convert first.
            </li>
            <li>
              <strong>Combine with Document.</strong> Turn a transcript into a polished report using
              the Document skill.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
