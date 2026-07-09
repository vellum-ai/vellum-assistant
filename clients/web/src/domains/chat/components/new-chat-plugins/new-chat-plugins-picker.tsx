import { useState } from "react";

import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { Link } from "react-router";

import { Tooltip } from "@vellumai/design-library";

import { routes } from "@/utils/routes";

import { PluginPill } from "./plugin-pill";
import type { UseNewChatPluginsResult } from "./use-new-chat-plugins";

/** Pills shown before the "Show all (+N)" expander reveals the rest. */
const COLLAPSED_PILL_COUNT = 12;

const TOOLTIP_COPY =
  "Choose which plugins this chat can use. Your selection is applied when you send your first message and stays with this conversation.";

type NewChatPluginsPickerProps = Pick<
  UseNewChatPluginsResult,
  "plugins" | "isSelected" | "toggle"
>;

/**
 * The revealed plugin picker: a labelled header with an info tooltip and a
 * "Manage Plugins" link, then a wrap of toggleable pills — one per installed
 * plugin — collapsed to the first {@link COLLAPSED_PILL_COUNT} behind a
 * "Show all (+N)" expander. Presentational; the installed list and selection
 * live in {@link NewChatPluginsSection}.
 */
export function NewChatPluginsPicker({
  plugins,
  isSelected,
  toggle,
}: NewChatPluginsPickerProps) {
  const [showAll, setShowAll] = useState(false);

  const hiddenCount = plugins.length - COLLAPSED_PILL_COUNT;
  const hasOverflow = hiddenCount > 0;
  const visiblePlugins = showAll
    ? plugins
    : plugins.slice(0, COLLAPSED_PILL_COUNT);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-title-small text-[var(--content-default)]">
          <span>Add plugins for new chat</span>
          <Tooltip content={TOOLTIP_COPY} side="top">
            <span className="inline-flex cursor-help items-center">
              <Info
                className="h-3.5 w-3.5 text-[var(--content-tertiary)]"
                aria-hidden
              />
            </span>
          </Tooltip>
        </div>
        <Link
          to={routes.plugins}
          className="text-body-medium-default text-[var(--primary-base)] hover:text-[var(--primary-hover)]"
        >
          Manage Plugins
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        {visiblePlugins.map((plugin) => (
          <PluginPill
            key={plugin.name}
            name={plugin.name}
            selected={isSelected(plugin.name)}
            onToggle={() => toggle(plugin.name)}
          />
        ))}
      </div>

      {hasOverflow ? (
        <button
          type="button"
          onClick={() => setShowAll((prev) => !prev)}
          className="flex items-center gap-1 self-start text-body-small-default text-[var(--content-tertiary)] hover:text-[var(--content-secondary)]"
        >
          {showAll ? (
            <>
              Show less
              <ChevronUp className="h-3.5 w-3.5" aria-hidden />
            </>
          ) : (
            <>
              {`Show all (+${hiddenCount})`}
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            </>
          )}
        </button>
      ) : null}
    </section>
  );
}
