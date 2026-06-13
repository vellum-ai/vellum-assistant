/**
 * CONTENT CONTRACT — this is the ONLY file to edit when populating the page.
 *
 * Overwrite the `profile` export below with what you learned about the user,
 * set `status` to "ready", keep the interfaces exactly as they are, then call
 * app_refresh (app_id: "personal-page"). The layout, animations, styles, and
 * media live in components/ and styles.css and must not be touched.
 *
 * The page is a cinematic dark landing page: a full-screen animated hero
 * with a giant one-word title, an about card with a serif-italic pull-up
 * heading, and a three-card grid for the person's main life areas.
 *
 * Field guidance (with a worked example for a fictional "Alex Nork"):
 * - hero.title: ONE short word in huge type — last name or nickname ("Nork").
 * - hero.description: 2–3 grounded sentences, third person ("Alex Nork is a
 *   software engineer based in Columbus, Ohio. Former Division I gymnast,
 *   current boulderer, building AI assistants at Vellum.")
 * - about.label: tiny kicker pairing their two worlds ("Software · Sport").
 * - about.heading: 2–4 segments; `italic: true` renders in serif italic for
 *   contrast ([{text: "I am Alex Nork,"}, {text: "a software engineer.",
 *   italic: true}, {text: "I build assistants and send boulders."}]).
 * - about.body: one 3–4 sentence paragraph with their best verified story.
 * - features.headingLine1/2: a two-line thesis ("Three disciplines, one
 *   operator." / "Engineering, climbing, gymnastics.").
 * - features.statusLabel: short present-tense caption ("Currently in
 *   Columbus, OH.").
 * - features.cards: EXACTLY 3 cards, one per life area. title is one word
 *   plus a period ("Engineering."). bullets are 3–4 one-fact lines, ~a dozen
 *   words, specific and verifiable — numbers, names, places beat adjectives.
 *   Card titles double as the page's nav tabs.
 * - Only include what you actually found; write around gaps rather than
 *   inventing facts.
 */

export interface AboutSegment {
  text: string;
  italic?: boolean;
}

export interface FeatureCard {
  title: string;
  bullets: string[];
}

export interface ProfileData {
  /** "pending" renders the researching state; "ready" renders the page. */
  status: "pending" | "ready";
  hero: {
    title: string;
    description: string;
  };
  about: {
    label: string;
    heading: AboutSegment[];
    body: string;
  };
  features: {
    headingLine1: string;
    headingLine2: string;
    statusLabel: string;
    cards: FeatureCard[];
  };
}

export const profile: ProfileData = {
  status: "pending",
  hero: {
    title: "",
    description: "",
  },
  about: {
    label: "",
    heading: [],
    body: "",
  },
  features: {
    headingLine1: "",
    headingLine2: "",
    statusLabel: "",
    cards: [],
  },
};
