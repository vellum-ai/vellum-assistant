import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { Box, Text } from "ink";

export interface TooltipProps {
  /** The tooltip text to display */
  text: string;
  /** Whether the tooltip trigger condition is active. When true, starts the delay timer. */
  visible?: boolean;
  /** Position relative to children: "above" or "below" */
  position?: "above" | "below";
  /** Delay in ms before showing the tooltip (default: 1000) */
  delay?: number;
  /** Children to wrap */
  children?: ReactNode;
}

/**
 * A Codex-style tooltip component for Ink terminal UI.
 *
 * Wraps children and shows a styled tooltip bubble (rounded border, bold text)
 * after a configurable delay when `visible` is true.
 *
 * Usage:
 *   <Tooltip text="Attach files" visible={isFocused}>
 *     <Text>📎</Text>
 *   </Tooltip>
 */
export function Tooltip({
  text,
  visible = true,
  position = "below",
  delay = 1000,
  children,
}: TooltipProps): ReactElement {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!visible) {
      setShow(false);
      return;
    }

    const timer = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(timer);
  }, [visible, delay]);

  const bubble = show ? (
    <Box borderStyle="round" borderColor="gray" alignSelf="flex-start">
      <Text bold> {text} </Text>
    </Box>
  ) : null;

  if (!children) {
    return bubble ?? <Text />;
  }

  return (
    <Box flexDirection="column">
      {position === "above" && bubble}
      {children}
      {position === "below" && bubble}
    </Box>
  );
}

export default Tooltip;
