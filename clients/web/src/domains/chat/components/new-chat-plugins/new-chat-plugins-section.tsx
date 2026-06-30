import { useState } from "react";

import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { Link } from "react-router";

import { Tooltip } from "@vellumai/design-library";

import { routes } from "@/utils/routes";

import { PluginPill } from "./plugin-pill";
import { useNewChatPlugins } from "./use-new-chat-plugins";

/** Pills shown before the "Show all (+N)" expander reveals the rest. */
const COLLAPSED_PILL_COUNT = 12;

const TOOLTIP_COPY =
  "Choose which plugins this chat can use. Your selection is applied when you send your first message and stays with this conversation.";

interface NewChatPluginsSectionProps {
  assistantId: string;
}

/**
 * Plugin picker that sits under the new-chat composer: a labelled header with
 * an info tooltip and a "Manage Plugins" link, then a wrap of toggleable pills
 * — one per installed plugin — collapsed to the first {@link COLLAPSED_PILL_COUNT}
 * behind a "Show all (+N)" expander. Renders nothing when nothing is installed.
 */
export function NewChatPluginsSection({
  assistantId,
}: NewChatPluginsSectionProps) {
  const { plugins, isSelected, toggle } = useNewChatPlugins(assistantId);
  const [expanded, setExpanded] = useState(false);

  if (plugins.length === 0) return null;

  const hiddenCount = plugins.length - COLLAPSED_PILL_COUNT;
  const hasOverflow = hiddenCount > 0;
  const visiblePlugins = expanded
    ? plugins
    : plugins.slice(0, COLLAPSED_PILL_COUNT);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)]">
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
          className="text-body-small-default text-[var(--content-tertiary)] hover:text-[var(--content-secondary)]"
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
          onClick={() => setExpanded((prev) => !prev)}
          className="flex items-center gap-1 self-start text-body-small-default text-[var(--content-tertiary)] hover:text-[var(--content-secondary)]"
        >
          {expanded ? (
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
