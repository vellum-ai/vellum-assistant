import { FadeIn, WordsPullUpMultiStyle } from "./animations";

export function Pending() {
  return (
    <section class="pending">
      <div class="noise-overlay" />
      <div class="pending-content">
        <FadeIn as="div" className="pending-label">
          YOUR PAGE
        </FadeIn>
        <h1 class="pending-heading">
          <WordsPullUpMultiStyle
            segments={[
              { text: "Being" },
              { text: "researched", className: "serif-italic" },
              { text: "right now." },
            ]}
            delayBase={0.2}
          />
        </h1>
        <FadeIn as="p" className="pending-sub" delay={0.9}>
          Your assistant is out on the open web learning about you. Check back
          in a minute.
        </FadeIn>
      </div>
    </section>
  );
}
