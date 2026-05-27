
import { motion } from "motion/react";
import { type CSSProperties, type ReactNode } from "react";

import { NODE_SPRING, NODE_VARIANT_CONFIGS, type NodeShellVariant } from "@/domains/intelligence/components/constellation-view/constants";
import { useNodeClickHandlers } from "@/domains/intelligence/components/constellation-view/use-node-click-handlers";
import { mixedBg, type NodeVisibility } from "@/domains/intelligence/components/constellation-view/utils";

export type { NodeShellVariant } from "@/domains/intelligence/components/constellation-view/constants";

export interface NodeShellProps {
  variant: NodeShellVariant;
  x: number;
  y: number;
  color: string;
  tooltip: string;
  visibility: NodeVisibility;
  delay: number;
  children: ReactNode;
  isSelected?: boolean;
  onSingleClick?: () => void;
  onDoubleClick?: () => void;
}

export function NodeShell({
  variant,
  x,
  y,
  color,
  tooltip,
  visibility,
  delay,
  children,
  isSelected,
  onSingleClick,
  onDoubleClick,
}: NodeShellProps) {
  const cfg = NODE_VARIANT_CONFIGS[variant];
  const { active, ...handlers } = useNodeClickHandlers(onSingleClick, onDoubleClick, isSelected);
  const style: CSSProperties = {
    left: x - cfg.size / 2,
    top: y - cfg.size / 2,
    width: cfg.size,
    height: cfg.size,
    borderRadius: cfg.cornerRadius,
    backgroundColor: mixedBg(color, active ? cfg.fillHoverPct : cfg.fillPct),
    borderStyle: cfg.dashed ? "dashed" : "solid",
    borderColor: mixedBg(color, active ? cfg.strokeHoverPct : cfg.strokePct),
    borderWidth: active ? cfg.strokeHoverWidth : cfg.strokeWidth,
    transition:
      "background-color 0.15s ease, border-color 0.15s ease, border-width 0.15s ease",
    cursor: onSingleClick || onDoubleClick ? "pointer" : "default",
  };
  return (
    <motion.div
      className="pointer-events-auto absolute flex flex-col items-center justify-center"
      data-constellation-node
      style={style}
      initial={{ opacity: 0, scale: 0.3 }}
      animate={{
        opacity: visibility.visible ? 1 : 0,
        scale: visibility.visible ? 1 : 0.3,
      }}
      transition={{ ...NODE_SPRING, delay }}
      onMouseEnter={handlers.onMouseEnter}
      onMouseLeave={handlers.onMouseLeave}
      onPointerDown={handlers.onPointerDown}
      onClick={handlers.onClick}
      title={tooltip}
    >
      {children}
    </motion.div>
  );
}
