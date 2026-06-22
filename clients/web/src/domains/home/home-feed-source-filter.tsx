import {
  Activity,
  Brain,
  ChevronDown,
  Circle,
  Clock,
  ListFilter,
  MessageCircle,
  Sparkles,
} from "lucide-react";
import { type ComponentType, type SVGProps } from "react";

import type { FeedItemSourceType } from "@vellumai/assistant-api";
import { Button, Menu } from "@vellumai/design-library";

import type { FeedSource } from "./utils";

type LucideIcon = ComponentType<SVGProps<SVGSVGElement>>;

/** Icon per coarse source type — shown on the trigger for the active source. */
const SOURCE_TYPE_ICONS: Record<FeedItemSourceType, LucideIcon> = {
  heartbeat: Activity,
  memory_consolidation: Brain,
  schedule: Clock,
  auto_analysis: Sparkles,
  user: MessageCircle,
  other: Circle,
};

const ALL_SOURCES = "all";

export interface HomeFeedSourceFilterProps {
  sources: FeedSource[];
  activeSource: string | null;
  onSourceChange: (sourceKey: string | null) => void;
}

/**
 * Single-select dropdown that filters the notification feed by the producer
 * of each item's source conversation (heartbeat, memory consolidation, a
 * specific recurring schedule, …). Hidden when there is at most one source,
 * mirroring the category filter bar.
 */
export function HomeFeedSourceFilter({
  sources,
  activeSource,
  onSourceChange,
}: HomeFeedSourceFilterProps) {
  if (sources.length <= 1) return null;

  const active = sources.find((s) => s.key === activeSource) ?? null;
  const TriggerIcon = active ? SOURCE_TYPE_ICONS[active.type] : ListFilter;

  return (
    <Menu.Root>
      <Menu.Trigger>
        <Button
          variant="outlined"
          size="compact"
          active={active !== null}
          leftIcon={<TriggerIcon className="h-4 w-4" />}
          rightIcon={<ChevronDown className="h-3.5 w-3.5" />}
          aria-label="Filter notifications by source"
        >
          {active ? active.label : "All sources"}
        </Button>
      </Menu.Trigger>
      <Menu.Content align="start" className="max-h-80 overflow-y-auto">
        <Menu.RadioGroup
          value={activeSource ?? ALL_SOURCES}
          onValueChange={(value: string) =>
            onSourceChange(value === ALL_SOURCES ? null : value)
          }
        >
          <Menu.RadioItem value={ALL_SOURCES}>All sources</Menu.RadioItem>
          <Menu.Separator />
          {sources.map((source) => (
            <Menu.RadioItem key={source.key} value={source.key}>
              {source.label}
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Root>
  );
}
