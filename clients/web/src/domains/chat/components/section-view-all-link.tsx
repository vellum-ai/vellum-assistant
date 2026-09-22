/**
 * "View all chats" on a sidebar section header, under `sidebar-done`.
 *
 * A section shows a window onto its chats, and a chat marked done leaves that
 * window without leaving the assistant. This is where it went: the Old chats
 * page, opened on the section's own filter.
 *
 * It stands beside the section's "…" in the header's trailing cell and wears
 * that control's exact box ({@link SECTION_HEADER_CONTROL_CLASSES}), so the
 * two read as one pair. Like the "…", the shared reveal rules paint it only
 * while the header is hovered or focused: nothing new is visible at rest.
 *
 * When a row in this section is marked done the icon flashes once (see
 * {@link useSectionDoneFlash}), so the eye follows the departing row to the
 * place it went. With reduced motion it does not.
 */

import { ArrowUpRight } from "lucide-react";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";
import { useEffect } from "react";
import { Link } from "react-router";

import { SECTION_HEADER_CONTROL_CLASSES } from "@/components/section-actions-button";
import { useSectionDoneFlash } from "@/domains/chat/components/section-done-flash";
import { useTranslation } from "@/i18n";

export function SectionViewAllLink({ to }: { to: string }) {
  const { t } = useTranslation("chat");
  const { count } = useSectionDoneFlash();
  const reduce = useReducedMotion();
  const controls = useAnimationControls();

  useEffect(() => {
    if (count === 0 || reduce) {
      return;
    }
    let cancelled = false;
    const pulse = async () => {
      /* Full strength, then back. The icon is painted by the reveal rules
         while the pointer is on the header and unpainted otherwise, so the
         flash is what makes the destination legible for the moment the row
         is leaving. */
      await controls.start({ opacity: 1, scale: 1.15 }, { duration: 0.09 });
      if (!cancelled) {
        await controls.start({ opacity: 0, scale: 1 }, { duration: 0.22 });
      }
    };
    void pulse().catch(() => {});
    return () => {
      cancelled = true;
      controls.stop();
    };
  }, [count, reduce, controls]);

  const label = t("sidebarSectionViewAll.label");

  return (
    <Link
      to={to}
      aria-label={label}
      title={label}
      onClick={(event) => event.stopPropagation()}
      className={SECTION_HEADER_CONTROL_CLASSES}
    >
      {/* The flash rides its own layer rather than the link's opacity: the
          reveal rules own that, and a value written onto the same property
          would hold the icon up after the pulse ended. */}
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[4px] bg-[var(--surface-active)]"
        initial={{ opacity: 0 }}
        animate={controls}
      />
      <ArrowUpRight
        size={14}
        aria-hidden
        className="relative max-md:h-[21px] max-md:w-[21px]"
      />
    </Link>
  );
}
