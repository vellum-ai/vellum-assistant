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

export function SkillsReferencePhoneCallsContent() {
  return (
    <>
      <DocsContent title="Phone Calls" breadcrumb="Docs / Skills Reference / Phone Calls">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Makes and receives phone calls via Twilio with real-time voice conversation. Your
            assistant can act as a receptionist, make calls on your behalf, and pull up past call
            transcripts.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Twilio account required. Say &ldquo;Set up phone calls.&rdquo; Your assistant walks you
            through provisioning a phone number.
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Twilio Account SID + Auth Token</li>
            <li>No macOS permissions needed (calls happen server-side)</li>
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
                    &ldquo;Call this number: 555-0123&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Initiates an outbound call
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Set up a receptionist for my business line&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Configures inbound call handling
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;What calls came in today?&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Lists recent call history
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Get me the transcript from my last call&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Retrieves call recording transcript
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
            <li>Voice powered by ElevenLabs text-to-speech</li>
            <li>Supports inbound and outbound calls</li>
            <li>Call transcripts are stored as conversation history</li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Guardian consultation.</strong> Your assistant can consult with you (the
              guardian) during a call if it&apos;s unsure how to handle something.
            </li>
            <li>
              <strong>Automatic transcription.</strong> Calls are transcribed automatically.
            </li>
            <li>
              <strong>Voice customization.</strong> Voice style is configurable through ElevenLabs
              settings.
            </li>
            <li>
              <strong>DTMF support.</strong> Keypad tones are supported for automated phone menus.
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
