/**
 * A tool call's raw input or raw output, behind a disclosure. `ToolDetailBody`
 * draws both for every call, below whatever presents the call readably, so the
 * raw data of every tool is in the same place under the same names.
 */

import { Disclosure } from "@vellumai/design-library/components/disclosure";

import { CodeBlock, SectionLabel } from "@/components/detail-primitives";
import { useTranslation } from "@/i18n";

/**
 * The raw text. Its own component so the disclosure, which unmounts closed
 * content, only builds the text once someone opens it: raw JSON can run to
 * hundreds of thousands of characters for a panel that never shows it.
 */
function RawText({ text }: { text: () => string }) {
  return <CodeBlock text={text()} />;
}

export function RawDisclosure({
  side,
  text,
}: {
  /** Which side of the call the raw text is. */
  side: "input" | "output";
  /** The raw text, built only when the disclosure opens. */
  text: () => string;
}) {
  const { t } = useTranslation("chat");
  return (
    <Disclosure.Root>
      <Disclosure.Trigger className="py-1 text-[var(--content-tertiary)] hover:text-[var(--content-secondary)]">
        <SectionLabel as="span" className="">
          {side === "input"
            ? t("rawDisclosure.input")
            : t("rawDisclosure.output")}
        </SectionLabel>
      </Disclosure.Trigger>
      {/* No name passed to the fold inside: the disclosure is a Radix
          accordion, whose content is already a region named by this label, and
          a second region of the same name nested in it names it twice. */}
      <Disclosure.Content className="pt-2">
        <RawText text={text} />
      </Disclosure.Content>
    </Disclosure.Root>
  );
}
