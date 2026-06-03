
import { motion } from "motion/react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

import {
  CENTER_AVATAR_SIZE,
  getCategoryConfig,
  type TreeNode,
} from "@/domains/intelligence/components/constellation-layout";

import { NODE_SPRING } from "@/domains/intelligence/components/constellation-view/constants";
import { NodeShell, type NodeShellVariant } from "@/domains/intelligence/components/constellation-view/node-shell";
import { SkillNode } from "@/domains/intelligence/components/constellation-view/skill-node";
import { nodeDelay, nodeVisibility } from "@/domains/intelligence/components/constellation-view/utils";

export interface NodeViewProps {
  node: TreeNode;
  index: number;
  phase: 0 | 1 | 2 | 3 | 4;
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  isSelected?: boolean;
  onSingleClick?: () => void;
  onDoubleClick?: () => void;
}

export function NodeView({
  node,
  index,
  phase,
  components,
  traits,
  customImageUrl,
  isSelected,
  onSingleClick,
  onDoubleClick,
}: NodeViewProps) {
  const visibility = nodeVisibility(node, phase);
  const delay = nodeDelay(node, index);

  if (node.kind.type === "center") {
    return (
      <motion.div
        className="pointer-events-none absolute"
        style={{
          left: node.x - CENTER_AVATAR_SIZE / 2,
          top: node.y - CENTER_AVATAR_SIZE / 2,
          width: CENTER_AVATAR_SIZE,
          height: CENTER_AVATAR_SIZE,
        }}
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{
          opacity: visibility.visible ? 1 : 0,
          scale: visibility.visible ? 1 : 0.6,
        }}
        transition={{ ...NODE_SPRING, delay }}
      >
        <ChatAvatar
          components={components}
          traits={traits}
          customImageUrl={customImageUrl}
          size={CENTER_AVATAR_SIZE}
        />
      </motion.div>
    );
  }

  if (node.kind.type === "category" || node.kind.type === "subCategory") {
    const cfg = getCategoryConfig(node.kind.category);
    const variant: NodeShellVariant =
      node.kind.type === "category" ? "category" : "subcategory";
    const emoji = node.kind.type === "category" ? cfg.emoji : node.kind.emoji;
    const label =
      node.kind.type === "category" ? cfg.displayName : node.kind.label;
    const emojiSize = variant === "category" ? "text-[20px]" : "text-[14px]";
    const labelClass =
      variant === "category"
        ? "mt-1 max-w-[85%] truncate text-label-medium-default leading-tight text-[var(--content-default)]"
        : "mt-0.5 max-w-[85%] truncate text-[9.5px] font-medium leading-tight text-[var(--content-default)]";
    return (
      <NodeShell
        variant={variant}
        x={node.x}
        y={node.y}
        color={cfg.color}
        tooltip={label}
        visibility={visibility}
        delay={delay}
        isSelected={isSelected}
        onSingleClick={onSingleClick}
        onDoubleClick={onDoubleClick}
      >
        {/* typography: constellation node glyph + label, fitted to geometric shape, intentionally off-scale */}
        <span
          className={`${emojiSize} leading-none` /* typography: off-scale */}
          aria-hidden
        >
          {emoji}
        </span>
        <span className={labelClass} title={label}>
          {label}
        </span>
      </NodeShell>
    );
  }

  if (node.kind.type === "skill") {
    const item = node.kind.item;
    const cfg = getCategoryConfig(item.category);
    return (
      <SkillNode
        x={node.x}
        y={node.y}
        item={item}
        color={cfg.color}
        fallbackEmoji={cfg.emoji}
        visibility={visibility}
        delay={delay}
        isSelected={isSelected}
        onSingleClick={onSingleClick}
        onDoubleClick={onDoubleClick}
      />
    );
  }

  return null;
}
