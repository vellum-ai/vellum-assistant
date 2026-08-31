import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

export interface ContentRevealProps {
  children: ReactNode;
  className?: string;
}

/** Fades resolved content in after a skeleton; instant under reduced motion. */
export function ContentReveal({ children, className }: ContentRevealProps) {
  const prefersReducedMotion = useReducedMotion();
  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
