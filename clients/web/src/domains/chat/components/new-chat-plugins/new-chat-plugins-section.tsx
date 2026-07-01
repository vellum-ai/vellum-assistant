import { useState } from "react";

import { Plug } from "lucide-react";

import { NewChatPluginsPicker } from "./new-chat-plugins-picker";
import { useNewChatPlugins } from "./use-new-chat-plugins";

interface NewChatPluginsSectionProps {
  assistantId: string;
}

/**
 * Entry point for the new-chat plugin picker under the composer. Collapsed by
 * default to a single centered "Add Plugins to Chat" button; clicking it
 * reveals the full {@link NewChatPluginsPicker}. Renders nothing when no
 * plugins are installed.
 */
export function NewChatPluginsSection({
  assistantId,
}: NewChatPluginsSectionProps) {
  const { plugins, isSelected, toggle } = useNewChatPlugins(assistantId);
  const [revealed, setRevealed] = useState(false);

  if (plugins.length === 0) return null;

  if (!revealed) {
    return (
      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="inline-flex h-[34px] cursor-pointer items-center gap-1 rounded-full border border-[var(--border-disabled)] bg-[var(--surface-base)] pl-2.5 pr-3 text-body-medium-default text-[var(--content-secondary)]"
        >
          <Plug className="h-4 w-4 shrink-0" aria-hidden />
          Add Plugins to Chat
        </button>
      </div>
    );
  }

  return (
    <NewChatPluginsPicker
      plugins={plugins}
      isSelected={isSelected}
      toggle={toggle}
    />
  );
}
