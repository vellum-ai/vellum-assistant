import type { ComponentChildren } from "preact";

import { profile } from "../profile-data";
import { StaggerCard, WordsPullUpMultiStyle } from "./animations";
import { ArrowRight, Check } from "./icons";
import { CARD_ICONS } from "./media";

function CheckLine({ children }: { children: ComponentChildren }) {
  return (
    <li>
      <Check className="check" />
      <span>{children}</span>
    </li>
  );
}

function LearnMore() {
  return (
    <a class="learn-more">
      Learn more
      <ArrowRight size={14} />
    </a>
  );
}

export function Features() {
  const { features } = profile;
  return (
    <section class="features">
      <div class="features-inner">
        <div class="features-header">
          <div>
            <WordsPullUpMultiStyle
              segments={[{ text: features.headingLine1, className: "line1" }]}
            />
          </div>
          <div style={{ marginTop: "0.3em" }}>
            <WordsPullUpMultiStyle
              segments={[{ text: features.headingLine2, className: "line2" }]}
              delayBase={0.2}
            />
          </div>
        </div>

        <div class="feature-grid">
          <StaggerCard index={0} className="feature-card visual">
            <div class="card-backdrop" />
            <div class="vlabel">{features.statusLabel}</div>
          </StaggerCard>

          {features.cards.slice(0, 3).map((card, i) => (
            <StaggerCard
              index={i + 1}
              className="feature-card"
              id={`feature-${i}`}
              key={card.title}
            >
              <img
                class="feature-icon"
                src={CARD_ICONS[i % CARD_ICONS.length]}
                alt=""
              />
              <div class="feature-num">{`0${i + 1}`}</div>
              <div class="feature-title">{card.title}</div>
              <ul class="feature-list">
                {card.bullets.map((b) => (
                  <CheckLine key={b}>{b}</CheckLine>
                ))}
              </ul>
              <LearnMore />
            </StaggerCard>
          ))}
        </div>
      </div>
    </section>
  );
}
