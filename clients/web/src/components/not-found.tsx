import { ArrowLeft, Sparkles } from "lucide-react";
import { motion, useReducedMotion, type Variants } from "motion/react";
import { useNavigate } from "react-router";

import { Button } from "@vellumai/design-library/components/button";

import { routes } from "@/utils/routes";

const container: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.07, delayChildren: 0.05 },
  },
};

const rise: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
  },
};

export function NotFound() {
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();

  return (
    <div
      data-slot="not-found"
      className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden p-6 text-center"
    >
      {/* Atmospheric layer: a soft primary glow over a faint dot grid, with a
          ghosted oversized 404 anchoring the composition behind the content. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div
          className="absolute left-1/2 top-1/2 size-[min(120vmin,900px)] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-40 blur-3xl"
          style={{
            background:
              "radial-gradient(circle at center, var(--content-quiet), transparent 60%)",
          }}
        />
        <div
          className="absolute inset-0 opacity-[0.4]"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, var(--border-subtle) 1px, transparent 0)",
            backgroundSize: "28px 28px",
            maskImage:
              "radial-gradient(ellipse 70% 60% at center, black, transparent 80%)",
            WebkitMaskImage:
              "radial-gradient(ellipse 70% 60% at center, black, transparent 80%)",
          }}
        />
        <motion.p
          initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
          animate={{ opacity: 0.05, scale: 1 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="absolute left-1/2 top-[42%] -translate-x-1/2 -translate-y-1/2 select-none text-[38vmin] font-bold leading-none tracking-tighter text-[var(--content-default)]"
        >
          404
        </motion.p>
      </div>

      <motion.div
        variants={reduceMotion ? undefined : container}
        initial={reduceMotion ? false : "hidden"}
        animate="show"
        className="relative flex max-w-md flex-col items-center gap-5"
      >
        <motion.span
          variants={rise}
          className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-base)] px-3 py-1 text-label-medium-default uppercase tracking-[0.18em] text-[var(--content-tertiary)]"
        >
          Error 404
        </motion.span>

        <motion.h1
          variants={rise}
          className="text-3xl font-semibold tracking-tight text-[var(--content-strong)]"
        >
          Page not found
        </motion.h1>

        <motion.p
          variants={rise}
          className="text-body-medium-default text-[var(--content-secondary)]"
        >
          The page you&apos;re looking for doesn&apos;t exist or may have moved.
        </motion.p>

        <motion.div
          variants={rise}
          className="mt-5 flex flex-col items-center gap-2.5"
        >
          <Button
            variant="primary"
            leftIcon={<Sparkles />}
            onClick={() => navigate(routes.assistant)}
          >
            Back to your assistant
          </Button>
          <Button
            variant="ghost"
            leftIcon={<ArrowLeft />}
            onClick={() => navigate(-1)}
          >
            Go back
          </Button>
        </motion.div>
      </motion.div>
    </div>
  );
}
