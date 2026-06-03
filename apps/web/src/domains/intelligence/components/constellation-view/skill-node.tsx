
import { motion } from "motion/react";

import { SKILL_NODE_SIZE } from "@/domains/intelligence/components/constellation-layout";
import type { OrbitItem } from "@/domains/intelligence/components/constellation-layout";
import { SkillIcon } from "@/domains/intelligence/components/skills/skill-icon";

import { NODE_SPRING } from "@/domains/intelligence/components/constellation-view/constants";
import { useNodeClickHandlers } from "@/domains/intelligence/components/constellation-view/use-node-click-handlers";
import { mixedBg, type NodeVisibility } from "@/domains/intelligence/components/constellation-view/utils";

export interface SkillNodeProps {
  x: number;
  y: number;
  item: OrbitItem;
  color: string;
  fallbackEmoji: string;
  visibility: NodeVisibility;
  delay: number;
  isSelected?: boolean;
  onSingleClick?: () => void;
  onDoubleClick?: () => void;
}

export function SkillNode({
  x,
  y,
  item,
  color,
  fallbackEmoji,
  visibility,
  delay,
  isSelected,
  onSingleClick,
  onDoubleClick,
}: SkillNodeProps) {
  const { active, ...handlers } = useNodeClickHandlers(onSingleClick, onDoubleClick, isSelected);
  // Skills use a diamond silhouette: only the background shape is rotated
  // 45°, while the icon + label render in a separate un-rotated layer so the
  // text always stays upright.
  return (
    <motion.div
      className="pointer-events-auto absolute"
      data-constellation-node
      style={{
        // Pre-subtract size/2 — motion rewrites style.transform for animated
        // scale, so a translate-50% centering would be dropped.
        left: x - SKILL_NODE_SIZE / 2,
        top: y - SKILL_NODE_SIZE / 2,
        width: SKILL_NODE_SIZE,
        height: SKILL_NODE_SIZE,
        cursor: onSingleClick || onDoubleClick ? "pointer" : "default",
      }}
      initial={{ opacity: 0, scale: 0.4 }}
      animate={{
        opacity: visibility.visible ? 1 : 0,
        scale: visibility.visible ? 1 : 0.4,
      }}
      transition={{ ...NODE_SPRING, delay }}
      onMouseEnter={handlers.onMouseEnter}
      onMouseLeave={handlers.onMouseLeave}
      onPointerDown={handlers.onPointerDown}
      onClick={handlers.onClick}
      title={item.label}
    >
      <div
        aria-hidden
        className="absolute inset-0 rounded-md"
        style={{
          transform: "rotate(45deg)",
          backgroundColor: mixedBg(color, active ? 20 : 10),
          border: `${active ? 2 : 1.5}px solid ${mixedBg(color, active ? 70 : 40)}`,
          transition:
            "background-color 0.15s ease, border-color 0.15s ease, border-width 0.15s ease",
        }}
      />
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <SkillIcon skill={item} className="h-4 w-4 text-[16px] leading-none" fallback={fallbackEmoji} />
        <span
          className="mt-0.5 max-w-[42px] truncate text-[9px] font-medium leading-tight text-[var(--content-default)]"
          title={item.label}
        >
          {item.label}
        </span>
      </div>
    </motion.div>
  );
}
