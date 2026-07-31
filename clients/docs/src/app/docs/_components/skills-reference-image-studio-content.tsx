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

export function SkillsReferenceImageStudioContent() {
  return (
    <>
      <DocsContent title="Image Studio" breadcrumb="Docs / Skills Reference / Image Studio">
        <section id="what-it-does">
          <SectionHeading id="what-it-does" level={2}>
            What it does
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
            Generates and edits images using AI models. Create illustrations, modify photos,
            generate art, and produce visual assets from text descriptions.
          </p>
        </section>

        <section id="setup-required" className="mt-12">
          <SectionHeading id="setup-required" level={2}>
            Setup required
          </SectionHeading>
          <p className="mb-0 text-zinc-600">
A Gemini API key is required. If one isn&apos;t configured, your assistant will
            prompt you to set it up on first use
          </p>
        </section>

        <section id="permissions" className="mt-12">
          <SectionHeading id="permissions" level={2}>
            Permissions
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>No macOS permissions needed for generation</li>
            <li>File system permission needed if saving images to your machine</li>
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
                    &ldquo;Generate an image of a sunset over mountains&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Creates an AI-generated image from your description
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Make me a logo for a coffee shop called &apos;Brew&apos;&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Generates a logo design
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Edit this image to remove the background&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Modifies an existing image
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Create a cartoon version of this photo&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Transforms an image style
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Make a banner image for my blog post about AI&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Generates sized-for-purpose assets
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    &ldquo;Generate 4 variations of this design&rdquo;
                  </td>
                  <td className="px-3 py-2">
                    Multiple options to choose from
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
              <strong>Models:</strong> Nano Banana 2 (default, fast) or Nano Banana Pro
              (higher quality, slower)
            </li>
            <li>
              <strong>Variants:</strong> Generate 1&ndash;4 variations per prompt to pick the
              best result
            </li>
            <li>
              <strong>Modes:</strong> Text-to-image (generate from a prompt) or edit mode
              (modify an existing image)
            </li>
          </ul>
        </section>

        <section id="tips-gotchas" className="mt-12">
          <SectionHeading id="tips-gotchas" level={2}>
            Tips &amp; gotchas
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Be descriptive:</strong> The more detail in your prompt, the better the
              result. &ldquo;A watercolor painting of a golden retriever sitting in a field of
              lavender at sunset&rdquo; beats &ldquo;a dog.&rdquo;
            </li>
            <li>
              <strong>Iterate:</strong> First generation not perfect? Say &ldquo;make it more colorful&rdquo;
              or &ldquo;try a different angle.&rdquo; Your assistant refines based on feedback.
            </li>
            <li>
              <strong>Formats:</strong> Images are generated as PNG or JPEG. Specify if you have
              a preference.
            </li>
            <li>
              <strong>File delivery:</strong> Generated images are delivered as attachments in chat.
              You can also ask your assistant to save them to a specific folder on your machine
              (requires file access permission).
            </li>
          </ul>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
