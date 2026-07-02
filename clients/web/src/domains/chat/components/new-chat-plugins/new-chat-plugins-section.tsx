import { useState } from "react";

import { Plug } from "lucide-react";

import { Button } from "@vellumai/design-library";

import { NewChatPluginsPicker } from "./new-chat-plugins-picker";
import { useNewChatPlugins } from "./use-new-chat-plugins";

interface NewChatPluginsSectionProps {
  assistantId: string;
}

/**
 * Entry point for the new-chat plugin picker under the composer. Collapsed by
 * default to a single centered "Manage Plugins" button; clicking it reveals
 * the full {@link NewChatPluginsPicker}. Renders nothing when no plugins are
 * installed.
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
        <Button
          variant="ghost"
          leftIcon={<Plug className="h-4 w-4 shrink-0" aria-hidden />}
          onClick={() => setRevealed(true)}
          tintColor="var(--content-secondary)"
          className="h-[34px] rounded-full border border-[var(--border-disabled)] pl-2.5 pr-3"
        >
          Manage Plugins
        </Button>
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
