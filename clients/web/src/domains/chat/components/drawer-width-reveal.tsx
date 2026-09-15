import { motion, useReducedMotion } from "motion/react";
import type { CSSProperties, ReactNode, Ref } from "react";

import { cn } from "@/utils/misc";

interface DrawerWidthRevealProps {
  ref?: Ref<HTMLDivElement>;
  id: string;
  width: number | string;
  open?: boolean;
  animateOnMount?: boolean;
  instant?: boolean;
  style?: CSSProperties;
  className?: string;
  resizeHandle?: ReactNode;
  onAnimationComplete?: () => void;
  children: ReactNode;
}

export function DrawerWidthReveal({
  ref,
  id,
  width,
  open = true,
  animateOnMount = false,
  instant = false,
  style,
  className,
  resizeHandle,
  onAnimationComplete,
  children,
}: DrawerWidthRevealProps) {
  const reduce = useReducedMotion();

  return (
    <motion.div
      ref={ref}
      id={id}
      className={cn("relative h-full shrink-0 overflow-hidden", className)}
      style={style}
      initial={animateOnMount ? { width: 0 } : false}
      animate={{ width: open ? width : 0 }}
      exit={{ width: 0 }}
      transition={
        instant || reduce
          ? { duration: 0 }
          : { duration: 0.34, ease: [0.16, 1, 0.3, 1] }
      }
      onAnimationComplete={onAnimationComplete}
    >
      {resizeHandle}
      {/* Fixed-width content is revealed without reflowing during the slide. */}
      {children != null && (
        <div className="absolute right-0 top-0 h-full" style={{ width }}>
          {children}
        </div>
      )}
    </motion.div>
  );
}
