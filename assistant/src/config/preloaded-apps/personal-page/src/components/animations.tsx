import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

type Segment = { text: string; className?: string };

function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function useInViewOnce<T extends HTMLElement>(
  rootMargin = "0px",
): { ref: (el: T | null) => void; inView: boolean } {
  const [inView, setInView] = useState(false);
  const elRef = useRef<T | null>(null);
  const obsRef = useRef<IntersectionObserver | null>(null);

  function ref(el: T | null) {
    if (elRef.current === el) return;
    if (obsRef.current) {
      obsRef.current.disconnect();
      obsRef.current = null;
    }
    elRef.current = el;
    if (el) {
      const obs = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            setInView(true);
            obs.disconnect();
            obsRef.current = null;
          }
        },
        { threshold: 0.15, rootMargin },
      );
      obs.observe(el);
      obsRef.current = obs;
    }
  }

  useEffect(() => () => obsRef.current?.disconnect(), []);

  return { ref, inView };
}

export function WordsPullUp({
  text,
  className,
  showAsterisk = false,
  delayBase = 0,
}: {
  text: string;
  className?: string;
  showAsterisk?: boolean;
  delayBase?: number;
}) {
  const { ref, inView } = useInViewOnce<HTMLSpanElement>();
  const words = splitWords(text);
  return (
    <span ref={ref} class={`${className ?? ""} ${inView ? "pull-in" : ""}`}>
      {words.map((word, i) => {
        const isLast = i === words.length - 1;
        return (
          <span
            class="pull-word"
            style={{
              animationDelay: `${delayBase + i * 0.08}s`,
              position: "relative",
            }}
          >
            {word}
            {showAsterisk && isLast ? (
              <span class="hero-asterisk">*</span>
            ) : null}
            {i < words.length - 1 ? "\u00A0" : null}
          </span>
        );
      })}
    </span>
  );
}

export function WordsPullUpMultiStyle({
  segments,
  className,
  delayBase = 0,
}: {
  segments: Segment[];
  className?: string;
  delayBase?: number;
}) {
  const { ref, inView } = useInViewOnce<HTMLSpanElement>();
  let globalIdx = 0;
  return (
    <span
      ref={ref}
      class={`${className ?? ""} ${inView ? "pull-in" : ""}`}
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
        justifyContent: "center",
        columnGap: "0.25em",
        rowGap: "0.05em",
      }}
    >
      {segments.map((seg) => {
        const words = splitWords(seg.text);
        return (
          <>
            {words.map((word) => {
              const delay = delayBase + globalIdx * 0.08;
              globalIdx += 1;
              return (
                <span
                  class={`pull-word ${seg.className ?? ""}`}
                  style={{ animationDelay: `${delay}s` }}
                >
                  {word}
                </span>
              );
            })}
          </>
        );
      })}
    </span>
  );
}

export function AnimatedParagraph({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    let raf = 0;
    let stopped = false;

    function update() {
      if (stopped || !ref.current) return;
      const spans =
        ref.current.querySelectorAll<HTMLSpanElement>(".about-letter");
      const rect = ref.current.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const startY = 0.8 * vh;
      const endY = 0.2 * vh;
      const total = startY - endY + rect.height;
      const elapsed = startY - rect.top;
      const progress = Math.max(0, Math.min(1, elapsed / total));
      const n = spans.length;
      for (let i = 0; i < n; i += 1) {
        const cp = i / Math.max(1, n - 1);
        const lo = cp - 0.1;
        const hi = cp + 0.05;
        let op = 0.2;
        if (progress >= hi) op = 1;
        else if (progress > lo) op = 0.2 + 0.8 * ((progress - lo) / (hi - lo));
        spans[i].style.opacity = String(op);
      }
      raf = requestAnimationFrame(update);
    }

    raf = requestAnimationFrame(update);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  const chars = Array.from(text);
  return (
    <p ref={ref} class={className}>
      {chars.map((ch) => (
        <span class="about-letter">{ch === " " ? "\u00A0" : ch}</span>
      ))}
    </p>
  );
}

export function FadeIn({
  delay = 0,
  duration = 0.8,
  children,
  as = "div",
  className,
}: {
  delay?: number;
  duration?: number;
  children: ComponentChildren;
  as?: "div" | "p" | "span" | "button";
  className?: string;
}) {
  const style: JSX.CSSProperties = {
    opacity: 0,
    transform: "translateY(20px)",
    animation: `fadeUp ${duration}s cubic-bezier(0.16, 1, 0.3, 1) ${delay}s forwards`,
  };
  const Tag = as;
  return (
    <Tag class={className} style={style}>
      {children}
    </Tag>
  );
}

export function StaggerCard({
  index,
  className,
  id,
  children,
}: {
  index: number;
  className?: string;
  id?: string;
  children: ComponentChildren;
}) {
  const { ref, inView } = useInViewOnce<HTMLDivElement>("-100px");
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (inView && !shown) {
      const t = window.setTimeout(() => setShown(true), index * 150);
      return () => window.clearTimeout(t);
    }
  }, [inView]);

  return (
    <div ref={ref} id={id} class={`${className ?? ""} ${shown ? "in" : ""}`}>
      {children}
    </div>
  );
}
