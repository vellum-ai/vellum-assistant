import { profile } from "../profile-data";
import { AnimatedParagraph, WordsPullUpMultiStyle } from "./animations";

export function About() {
  const { about } = profile;
  return (
    <section class="about" id="about">
      <div class="about-card">
        <div class="about-label">{about.label}</div>
        <h2 class="about-heading">
          <WordsPullUpMultiStyle
            segments={about.heading.map((seg) => ({
              text: seg.text,
              className: seg.italic ? "serif-italic" : undefined,
            }))}
          />
        </h2>
        <AnimatedParagraph className="about-body" text={about.body} />
      </div>
    </section>
  );
}
