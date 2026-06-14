import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";

/**
 * Cycles `words` in place inside the headline with a vertical cross-fade,
 * rendered as a styled `<em>` (see `.cast-login__title em`). A hidden sizer
 * (longest word) reserves width so the headline doesn't reflow. Ported from
 * the cast prototype's RotatingWord.
 */
export function RotatingWord({ words }: { words: string[] }) {
  const [index, setIndex] = useState(0);
  const longest = useMemo(
    () => words.reduce((a, b) => (a.length >= b.length ? a : b)),
    [words],
  );

  useEffect(() => {
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % words.length);
    }, 2400);
    return () => clearInterval(id);
  }, [words.length]);

  return (
    <span className="cast-login__rotating">
      <span className="cast-login__rotating-sizer" aria-hidden>
        {longest}.
      </span>
      <AnimatePresence mode="wait">
        <motion.em
          key={words[index]}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -16 }}
          transition={{ duration: 0.3, ease: "easeInOut" }}
        >
          {words[index]}.
        </motion.em>
      </AnimatePresence>
    </span>
  );
}
