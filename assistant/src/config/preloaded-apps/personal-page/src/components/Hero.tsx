import { profile } from "../profile-data";
import { FadeIn, WordsPullUp } from "./animations";

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}

export function Hero() {
  const { hero, features } = profile;
  // Nav entries map to the page's real sections: the about card plus one
  // entry per feature card. Labels come from the content itself, so every
  // tab has a guaranteed scroll target.
  const navItems = [
    { label: "About", target: "about" },
    ...features.cards.slice(0, 3).map((card, i) => ({
      label: card.title.replace(/\.+$/, ""),
      target: `feature-${i}`,
    })),
  ];
  return (
    <section class="hero">
      <div class="hero-frame">
        <div class="hero-backdrop" />
        <div class="noise-overlay" />
        <div class="hero-gradient" />

        <nav class="navbar">
          {navItems.map((item) => (
            <a
              href={`#${item.target}`}
              key={item.target}
              onClick={(e) => {
                e.preventDefault();
                scrollToSection(item.target);
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div class="hero-content">
          <div class="hero-title-col">
            <h1 class="hero-title">
              <WordsPullUp text={hero.title} showAsterisk />
            </h1>
          </div>
          <div class="hero-desc-col">
            <FadeIn as="p" className="hero-desc" delay={0.5}>
              {hero.description}
            </FadeIn>
          </div>
        </div>
      </div>
    </section>
  );
}
