import { Plug } from "lucide-react";

import { Button } from "@vellumai/design-library";

interface PluginPillProps {
  name: string;
  selected: boolean;
  onToggle: () => void;
}

export function PluginPill({ name, selected, onToggle }: PluginPillProps) {
  return (
    <Button
      variant="outlined"
      active={selected}
      leftIcon={<Plug className="h-4 w-4 shrink-0" aria-hidden />}
      onClick={onToggle}
      aria-pressed={selected}
      aria-label={`${selected ? "Disable" : "Enable"} ${name} for this chat`}
      tintColor={
        selected ? "var(--content-default)" : "var(--content-secondary)"
      }
      className="h-[34px] rounded-full pl-2.5 pr-3"
    >
      {name}
    </Button>
  );
}
