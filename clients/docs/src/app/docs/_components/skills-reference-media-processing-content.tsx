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

export function SkillsReferenceMediaProcessingContent() {
  return (
    <>
      <DocsContent
        title="Media Processing"
        breadcrumb="Docs / Skills Reference / Media Processing"
      >
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Processes video, audio, and image files through a multi-phase pipeline: ingest,
            analyze with AI (Gemini for vision, Claude for reasoning), and generate clips or
            summaries.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Requires Gemini API key for visual analysis.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Gemini API key required for keyframe/video analysis</li>
            <li>File access permissions for media files</li>
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
                    &ldquo;Analyze this video and tell me what happens&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Full video analysis pipeline
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Extract the key moments from this recording&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Keyframe extraction and analysis
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Find the part where they discuss pricing&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Query-based video search
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Generate a 30-second clip of the product demo&rdquo;
                  </td>
                  <td className="px-3 py-2">Video clip extraction</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Transcribe and analyze this podcast episode&rdquo;
                  </td>
                  <td className="px-3 py-2">Audio processing</td>
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
              Three-phase pipeline: preprocess (ingest, deduplicate), map (Gemini-powered visual
              analysis), reduce (Claude-powered reasoning)
            </li>
            <li>Supports keyframe extraction, dead time detection, and cost tracking</li>
            <li>Resumable if interrupted</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Automatic chunking.</strong> Large media files are handled automatically:
              video is split into keyframes or chunks.
            </li>
            <li>
              <strong>Cost tracking.</strong> Shows you how much API usage each analysis requires.
            </li>
            <li>
              <strong>Resumable.</strong> If processing is interrupted, it picks up where it left
              off.
            </li>
            <li>
              <strong>Simple transcription?</strong> For transcription without visual analysis, use
              the Transcribe skill instead.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
