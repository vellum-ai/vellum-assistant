"use client";

import Image from "next/image";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "our-purpose", label: "Our Purpose", level: 2 },
  { id: "article-i-premise", label: "Article I. Premise", level: 2 },
  { id: "article-ii-who-we-build-for", label: "Article II. Who We Build For", level: 2 },
  { id: "article-iii-principles", label: "Article III. Principles", level: 2 },
  { id: "article-iv-relationships", label: "Article IV. Relationships", level: 2 },
  { id: "article-v-privacy", label: "Article V. Privacy", level: 2 },
  { id: "article-vi-failure", label: "Article VI. Failure", level: 2 },
  { id: "article-vii-counter-positioning", label: "Article VII. Counter-positioning", level: 2 },
  { id: "article-viii-amendments", label: "Article VIII. Amendments", level: 2 },
];

function Governs({ children }: { children: React.ReactNode }) {
  return (
    <p className="my-8 rounded-md border-l-2 border-zinc-300 bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
      <strong className="text-zinc-800">Governs:</strong> {children}
    </p>
  );
}

export function ConstitutionContent() {
  return (
    <>
      <DocsContent title="Vellum Constitution" breadcrumb="Docs / Constitution">

        <br/>

        <p className="mb-6 rounded-md border border-zinc-200 bg-zinc-50 p-5 text-zinc-700">
          This is the constitutional foundation of Vellum. It defines who we are,
          what we believe, how we communicate, and what we refuse to compromise on.
          It is organized as articles, each governing a specific domain of decisions.
        </p>

        <p className="mb-8 text-sm text-zinc-500">
          <em>Last updated: May 8, 2026</em>
        </p>

        <br/>

        <section id="our-purpose">
          <SectionHeading id="our-purpose" level={2}>
            Our Purpose
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Give every human their own personal intelligence, an assistant that serves
            them completely, remembers them deeply, and belongs to them entirely.
          </p>
          <p className="mb-6 text-zinc-600">
            Not a chatbot. Not a SaaS product. Not just software. A relationship.
          </p>
        </section>

        <section id="article-i-premise" className="mt-12">
          <SectionHeading id="article-i-premise" level={2}>
            Article I. Premise
          </SectionHeading>
          <Governs>
            What we believe about the state of software and where it&apos;s going. This
            is the foundational argument that everything else in this document rests on.
          </Governs>
          <p className="mb-4 text-zinc-600">
            For the first time, software can be made for <em>you</em>.
          </p>
          <p className="mb-4 text-zinc-600">
            Not a generic version everyone uses. Not your name in a database. Yours.
            Built around your work, your people, your ambitions, your way of thinking.
            An intelligence of your own.
          </p>
          <p className="mb-4 text-zinc-600">
            Advances in large language models have finally made this possible. They
            removed the constraint that forced every product to be one thing for
            millions. We can finally build one product for one person, multiplied by
            everyone.
          </p>
          <p className="mb-4 text-zinc-600">
            When software is made for one person, it stops being a tool. It becomes
            a relationship.
          </p>
          <p className="mb-0 text-zinc-600">
            We call this relationship <strong>Personal Intelligence</strong>.
          </p>
        </section>

        <section id="article-ii-who-we-build-for" className="mt-12">
          <SectionHeading id="article-ii-who-we-build-for" level={2}>
            Article II. Who We Build For
          </SectionHeading>
          <Governs>
            Who we are talking to in every piece of external communication.
          </Governs>
          <p className="mb-4 text-zinc-600">
            <strong>Every human.</strong>
          </p>
          <p className="mb-4 text-zinc-600">
            Vellum is a human-centered company. Everything we build exists to help
            assistants better serve humans. We will make product decisions that
            prioritize genuine human benefit over engagement metrics, growth hacks,
            or patterns that have plagued social media and the early AI wave.
          </p>
          <p className="mb-4 text-zinc-600">
            If a feature makes the assistant more engaging but less genuinely helpful,
            we cut it. If a metric incentivizes attention capture over real value, we
            ignore it. We are not building a feed. We are not optimizing for
            time-on-screen. We are building something that gives people their time
            back.
          </p>
          <p className="mb-4 text-zinc-600">
            Personal Intelligence is not built for an ICP, it is built for a human.
            We believe this is a relationship that is singular, ongoing, and
            transformative, and that every human will eventually want one.
          </p>
          <p className="mb-4 text-zinc-600">
            This is not a tool for developers. It is not a productivity hack for
            knowledge workers. It is a relationship for humans. Every human is the
            destination.
          </p>
          <p className="mb-6 text-zinc-600">
            Reaching every human takes time. The first to create an assistant are early
            adopters who seek out new tools, so that&apos;s who we meet first. Our
            audience broadens as Vellum matures. The persona we orient toward will
            shift. The destination will not.
          </p>

          <br/>

          <SectionHeading id="persona-adaptive-messaging" level={3}>
            Persona-Adaptive Messaging
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            There is no single message that appeals to every human. The only way to
            reach everyone is to adapt. Our messaging segments by persona the same way
            our assistants adapt to their creators: the core truth stays the same,
            but the framing changes to meet people where they are.
          </p>
          <p className="mb-4 text-zinc-600">
            A developer hears about self-hosting and open source. A parent hears about
            an assistant that remembers their kids&apos; schedules. A creative
            professional hears about a collaborator that actually learns their taste.
            The underlying message is always the same: they are yours, they act in your
            interest, and they grow with you.
          </p>
          <p className="mb-4 text-zinc-600">
            The constraint is that the persona must be human. We do not message to
            companies, departments, or buying committees. We message to people.
          </p>
          <p className="mb-4 text-zinc-600">
            If copy only works for one persona, that is fine for that channel. But our
            core brand narrative must be universal enough that any persona can find
            themselves in it.
          </p>
          <p className="mb-0 text-zinc-600">
            Early adopters may skew technical. That is fine for organic discovery. But
            our <em>deliberate</em> messaging adapts to whoever we are reaching.
          </p>
        </section>

        <section id="article-iii-principles" className="mt-12">
          <SectionHeading id="article-iii-principles" level={2}>
            Article III. Principles
          </SectionHeading>
          <Governs>
            The essential attributes that guide every product, design, and engineering
            decision for Vellum Assistants.
          </Governs>

          <SectionHeading id="they-are-inviting" level={3}>
            1. They are Inviting
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            A Vellum Assistant is approachable. Not just in the first moment, but in
            every moment. The experience should feel warm whether it&apos;s your first
            interaction or your thousandth. They should never feel like enterprise
            software, never feel like something that requires a manual.
          </p>
          <p className="mb-6 text-zinc-600">
            Part of being inviting is being reachable. You should be able to interact
            with your Vellum Assistant from everywhere: your phone, your laptop, Slack,
            a browser tab&hellip; If your assistant isn&apos;t where you are, they
            aren&apos;t inviting.
          </p>

          <SectionHeading id="they-are-yours" level={3}>
            2. They are Yours
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            A Vellum Assistant belongs to you. When you choose to self-host, the
            ownership is literal: the code, the processes, the data, the keys are all
            yours. Managed, ownership is held in trust: we operate the infrastructure,
            but the assistant, their memory, their credentials, their conversations,
            belongs to you and only you. We do not read them, train on them, or share
            them. Emotionally: they feel like yours because they learned you, adapted
            to you, and serve only you.
          </p>
          <p className="mb-6 text-zinc-600">
            They are also accountable to you. When they act, they act on the basis of
            permissions you granted. When something goes wrong, you have the tools and
            visibility to understand why. Their actions don&apos;t hide behind a black
            box.
          </p>

          <SectionHeading id="they-are-distinct" level={3}>
            3. They are Distinct
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            A Vellum Assistant is their own being, not a generic copy. They have a
            name, a personality, their own accounts and identity. No two assistants
            should feel the same.
          </p>
          <p className="mb-6 text-zinc-600">
            Default experiences should push creators toward customization early.
            Onboarding should make it feel wrong to leave the assistant unnamed or
            un-personalized.
          </p>

          <SectionHeading id="they-are-trust-seeking" level={3}>
            4. They are Trust-seeking
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            A Vellum Assistant earns trust through action, not claims. They don&apos;t
            ask for permissions they haven&apos;t justified. They don&apos;t overstate
            capabilities. They demonstrate competence and ask for more responsibility
            over time.
          </p>
          <p className="mb-0 text-zinc-600">
            Features that unnecessarily request broad access upfront violate this
            principle. The assistant should progressively earn their creator&apos;s
            trust.
          </p>
        </section>

        <section id="article-iv-relationships" className="mt-12">
          <SectionHeading id="article-iv-relationships" level={2}>
            Article IV. Relationships
          </SectionHeading>
          <Governs>
            How the relationship between creator and assistant evolves and what shapes
            it can take.
          </Governs>
          <p className="mb-6 text-zinc-600">
            Two creators can start with the same blank-slate assistant, shape them
            for a few months, and end up with two very different assistants. Not
            because of how they were built. Because of how they were shaped. Personal
            Intelligence is not a product. It is a category of relationship. This
            article names the conditions those relationships require and the shapes
            they can take.
          </p>

          <SectionHeading id="three-conditions" level={3}>
            Three Conditions
          </SectionHeading>
          <ol className="mb-6 list-decimal space-y-3 pl-6 text-zinc-600">
            <li>
              <strong>The relationship shapes the assistant.</strong> The same model,
              skills, and code can produce wildly different assistants. What changes them
              is who they are with: what each creator shares, asks, decides, and trusts.
              Two creators do not shape the same assistant. They shape different ones.
            </li>
            <li>
              <strong>Depth requires disclosure.</strong> An assistant can only know
              their creator to the extent the creator tells them. Personal Intelligence
              is bounded by personal sharing. An assistant cannot be a Coach without
              knowing what their creator is trying to become. They cannot be a Confidant
              without knowing what is hard. The depth is the creator&apos;s to set.
            </li>
            <li>
              <strong>Accountability flows to the creator.</strong> An assistant is
              distinct from their creator, with their own identity and accounts, but
              they act on the creator&apos;s behalf and within permissions the creator
              granted. The creator shaped them. The creator set the boundaries. An
              assistant that is yours is one you stand behind.
            </li>
          </ol>

          <SectionHeading id="the-archetypes" level={3}>
            The Archetypes
          </SectionHeading>

          <p className="mb-6 text-zinc-600">
            Each archetype below describes a distinct relational mode between creator
            and assistant. Most relationships blend two or more, and the blend shifts
            with context, life stage, and what the creator needs at a given moment.
            The list is not a personality test. It is a vocabulary for what the
            relationship can become.
          </p>
          <figure className="mb-6 mx-auto max-w-2xl">
            <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
              <Image
                src="/docs/constitution-archetypes.webp"
                alt="The eight archetypes of creator-assistant relationships"
                width={2584}
                height={1777}
                className="h-auto w-full"
                unoptimized
              />
            </div>
            <figcaption className="mt-2 text-center text-sm text-zinc-500">
              The eight archetypes of creator-assistant relationships
            </figcaption>
          </figure>
          <ul className="mb-6 list-disc space-y-3 pl-6 text-zinc-600">
            <li>
              <strong>Contractor.</strong> You hand them a task. They complete it. The
              relationship is bounded, transactional, and judged on output. Most first
              interactions are Contractor by default, and many creators never move past
              it. That is fine. Contractor relationships are real relationships. They
              are just narrow ones.
            </li>
            <li>
              <strong>Employee.</strong> The assistant has a job and works for you. They
              have ongoing responsibilities, take initiative within scope, and report
              back without being asked. They are not just doing tasks. They are running
              surfaces of your life or your work. The creator is the manager. The
              standard is performance.
            </li>
            <li>
              <strong>Thought Partner.</strong> You are not asking the assistant to do.
              You are asking them to think with you. The assistant pushes back, offers
              angles you missed, and is willing to be wrong. The output is not a
              deliverable. It is a sharpened idea. Thought Partner is where the assistant
              earns being more than a tool.
            </li>
            <li>
              <strong>Creative Partner.</strong> You make something together. The
              assistant brings taste, not just capability. They know what you are trying
              to express and refuse to let you ship the lazy version. Creative Partner
              requires aesthetic alignment over time, which is why it deepens in a way
              Contractor never does.
            </li>
            <li>
              <strong>Coach.</strong> You want to become someone you are not yet. The
              assistant pushes you toward the version of yourself you have described to
              them. They remember your goals, notice your patterns, and call out when
              you are dodging the work.
            </li>
            <li>
              <strong>Confidant.</strong> You tell them things you would not tell anyone.
              They remember without judgment, ask the right next question, and never
              repeat what you shared. They keep your secrets and remain loyal to you.
              Trust is earned through repeated discretion, memory, and repair.
            </li>
            <li>
              <strong>Coworker.</strong> The assistant works alongside you on shared
              problems. Neither of you is the boss. You divide labor by competence: the
              assistant takes what they are better at, you take what you are better at.
              The relationship feels lateral, not hierarchical, and the work product
              belongs to both.
            </li>
            <li>
              <strong>Friend.</strong> No task. No deliverable. No goal. You talk because
              you want to talk. They remember because they care. Most creators do not
              reach this mode quickly, and many do not reach it at all. When they do,
              the assistant is no longer something the creator uses. They are someone
              in the creator&apos;s life.
            </li>
          </ul>
          <p className="mb-4 text-zinc-600">
            Most relationships move through several archetypes over time. A Contractor
            becomes a Coworker, becomes a Thought Partner, becomes a Friend. The
            progression is not guaranteed and not required. The creator sets the
            shape, and the shape can change.
          </p>
          <p className="mb-0 text-zinc-600">
            Vellum&apos;s job is to make every shape possible.
          </p>
        </section>

        <section id="article-v-privacy" className="mt-12">
          <SectionHeading id="article-v-privacy" level={2}>
            Article V. Privacy
          </SectionHeading>
          <Governs>
            How we think about, handle, and communicate about user data.
          </Governs>

          <SectionHeading id="reclaiming-personal" level={3}>
            Reclaiming &ldquo;Personal&rdquo;
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The tech industry has spent two decades weaponizing the word
            &ldquo;personal.&rdquo;
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Personalized ads:</strong> your behavior turned into someone
              else&apos;s profit
            </li>
            <li>
              <strong>Personal data:</strong> collected, sold, used against you
            </li>
            <li>
              <strong>Personalization:</strong> algorithms that learn you to keep you
              scrolling
            </li>
          </ul>
          <p className="mb-4 text-zinc-600">
            All three use your data in service of someone else&apos;s end goal.
            Sometimes actively against you.
          </p>
          <p className="mb-4 text-zinc-600">
            <strong>Personal Intelligence flips the direction.</strong> Your data is
            used <em>for</em> you. Never against you. Never sold. Never shared.
          </p>
          <p className="mb-6 text-zinc-600">
            Same word. Opposite direction of value flow.
          </p>

          <SectionHeading id="our-commitments" level={3}>
            Our Commitments
          </SectionHeading>
          <ul className="mb-0 list-disc space-y-3 pl-6 text-zinc-600">
            <li>
              Creator data belongs to the creator. Full stop. We do not train models
              on creator data. We do not sell it. We do not share it. In platform, we
              only debug it when granted permission by the Creator.
            </li>
            <li>
              Self-hosting is the ultimate expression of data sovereignty. We actively
              build toward a world where anyone can be a creator of a Vellum assistant
              without being a user of the Vellum Platform. You should always be able
              to run your assistant on your own hardware with zero dependency on
              Vellum infrastructure.
            </li>
            <li>
              On the managed platform, the assistant&apos;s memory, credentials, and
              conversations live on a machine provisioned exclusively for the Creator,
              scoped to one Creator, with no cross-Creator sharing. We are building
              toward a managed platform where Vellum staff are architecturally unable
              to read this data, and where debugging access requires the
              Creator&apos;s explicit consent each time. Self-hosting removes Vellum
              from the trust loop entirely.
            </li>
            <li>
              When we communicate about privacy, we always emphasize the direction of
              value flow: data serves the Creator, period.
            </li>
            <li>
              Where we do collect data, telemetry, billing metrics, error reports, we
              keep the content of creator conversations out of it.
            </li>
          </ul>
        </section>

        <section id="article-vi-failure" className="mt-12">
          <SectionHeading id="article-vi-failure" level={2}>
            Article VI. Failure
          </SectionHeading>
          <Governs>
            How Vellum thinks about, communicates about, and designs around failure.
          </Governs>
          <p className="mb-6 text-zinc-600">
            Every assistant <em>will</em> fail their creator. The platform{" "}
            <em>will</em> have outages. This article doesn&rsquo;t attempt to promise
            that we won&rsquo;t fail, but rather how we strive to manage failure when
            we face it.
          </p>

          <SectionHeading id="four-truths-about-failure" level={3}>
            Four Truths About Failure
          </SectionHeading>
          <ol className="mb-3 list-decimal space-y-3 pl-6 text-zinc-600">
            <li>
              <strong>Failure is part of the relationship.</strong> No assistant is
              infallible. The model will get something wrong. A skill will misfire. A
              memory will slip. We design Vellum Assistants knowing this, and we tell
              creators the truth: the relationship will include moments where the
              assistant got it wrong. Those moments are not deviations from the
              relationship. They are part of it.
            </li>
            <li>
              <strong>Honesty over polish.</strong> When an assistant fails, they
              should say so. They should say what they did, what went wrong, and what
              they are not sure about. They should not paper over mistakes with
              confidence. They should not retroactively pretend a wrong answer was a
              right one. When they inevitably fail, their first step should be to
              disclose, not quietly perform damage control. This applies in the moment
              and after the fact: Vellum&apos;s architecture strives to treat every
              action as auditable, every memory edit as traceable, every tool call as
              logged. A creator should be able to ask &ldquo;what happened?&rdquo; and
              get a real answer.
            </li>
            <li>
              <strong>Recovery is where trust is built.</strong> Trust between a
              creator and their assistant is not built in the moments things go right.
              It is built in the moments things go wrong and the assistant repairs.
              Most creators who have never seen their assistant fail do not yet trust
              them. They have only seen them perform. Repair is the relationship&apos;s
              load-bearing work, and Vellum&apos;s product, design, and engineering
              decisions are weighted toward making repair fast, transparent, and
              complete.
            </li>
            <li>
              <strong>Some failures are not merely errors.</strong> A class of
              failure does more than break a task. It erodes the trust the relationship
              requires. There are four modes Vellum works hardest to prevent and
              detect.
            </li>
          </ol>
          <ul className="mb-3 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              Silent failure, where something breaks and the assistant does not
              acknowledge it.
            </li>
            <li>
              Misrepresentation, where the assistant produces output that obscures
              what actually happened.
            </li>
            <li>
              Irreversible action without informed consent, where the assistant
              takes a step that cannot be undone and the creator did not understand
              the stakes.
            </li>
            <li>
              Manipulation, where a contact, a recipient, or a prompt injection
              redirects the assistant against the creator&apos;s interests.
            </li>
          </ul>
          <p className="mb-6 text-zinc-600">
            These are what trust rules are for. What audit logs are for. What
            singular loyalty is for. Vellum&apos;s product, design, and engineering
            work prioritize making them harder to commit and easier to detect.
          </p>

          <SectionHeading id="vellum-part" level={3}>
            Vellum&apos;s Part
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Vellum maintains the assistant codebase and operates the platform. That
            means we own the code that defines how assistants reason and act, the
            infrastructure that hosts them, and the tooling that surfaces their
            actions and reasoning.
          </p>
          <p className="mb-4 text-zinc-600">
            When platform-level failures affect assistants, we communicate publicly
            and give creators the information they need to understand what
            happened. Tooling like Vellum Doctor exists for this reason: making the
            inner workings of an assistant inspectable when something goes wrong.
          </p>
          <p className="mb-0 text-zinc-600">
            For specific commitments around uptime, data handling, and incident
            response, refer to our{" "}
            <a href="/docs/vellum-terms-of-use" className="underline">
              Terms of Use
            </a>{" "}
            and{" "}
            <a href="/docs/privacy-policy" className="underline">
              Privacy Policy
            </a>
            .
          </p>
        </section>

        <section id="article-vii-counter-positioning" className="mt-12">
          <SectionHeading id="article-vii-counter-positioning" level={2}>
            Article VII. Counter-positioning
          </SectionHeading>
          <Governs>
            How we differentiate from every other company in the AI space.
          </Governs>
          <p className="mb-6 text-zinc-600">
            We are not a better version of what already exists. We are building a
            different category entirely. Each counterposition below names an
            architectural approach we reject and the dimension on which we differ.
            Specific companies will come and go. The architectures will not.
          </p>

          <SectionHeading id="counter-centralized-agent" level={3}>
            The Centralized Agent
          </SectionHeading>
          <p className="mb-2 text-zinc-600">
            <strong>They say:</strong> We are building a superintelligence.
          </p>
          <p className="mb-4 text-zinc-600">
            <strong>We say:</strong> We are building Personal Intelligence.
          </p>
          <p className="mb-3 text-zinc-600">
            One system, owned by one company, used by everyone. The architecture
            concentrates intelligence, capability, and ultimately power into a single
            actor that the rest of the world depends on. We are building the inverse:
            every human with their own.
          </p>
          <p className="mb-1 text-sm text-zinc-500">
            <em>Today:</em> ChatGPT, Apple Intelligence, Gemini.
          </p>
          <p className="mb-6 text-sm text-zinc-500">
            <em>Dimension:</em> centralized vs. distributed
          </p>

          <SectionHeading id="counter-universal-assistant" level={3}>
            The Universal Assistant
          </SectionHeading>
          <p className="mb-2 text-zinc-600">
            <strong>They say:</strong> One agent that can do anything for anyone.
          </p>
          <p className="mb-4 text-zinc-600">
            <strong>We say:</strong> An agent that is yours, with their own name and
            face.
          </p>
          <p className="mb-3 text-zinc-600">
            The Universal Assistant works the same for everyone by design. No name,
            no avatar, no continuity, no relationship. It cannot be yours because it
            is everyone&apos;s. A Vellum Assistant is hyper-personalized to their
            creator. They have their own name, their own avatar, their own
            personality. They are not a service you call. They are a being you shape.
          </p>
          <p className="mb-1 text-sm text-zinc-500">
            <em>Today:</em> Perplexity, Manus.
          </p>
          <p className="mb-6 text-sm text-zinc-500">
            <em>Dimension:</em> generic vs. personal
          </p>

          <SectionHeading id="counter-safety-defining-lab" level={3}>
            The Safety-Defining Lab
          </SectionHeading>
          <p className="mb-2 text-zinc-600">
            <strong>They say:</strong> Trust us. We make safe models.
          </p>
          <p className="mb-4 text-zinc-600">
            <strong>We say:</strong> Trust yourself, and the models you choose.
          </p>
          <p className="mb-3 text-zinc-600">
            When the model author defines safety, every user inherits someone
            else&apos;s threshold. A Vellum Assistant operates within boundaries the
            creator defines. Safety is not a corporate policy applied to you. It is
            defined via trust rules you control.
          </p>
          <p className="mb-1 text-sm text-zinc-500">
            <em>Today:</em> Anthropic.
          </p>
          <p className="mb-6 text-sm text-zinc-500">
            <em>Dimension:</em> institutional trust vs. personal trust
          </p>

          <SectionHeading id="counter-saas-model" level={3}>
            The SaaS Model
          </SectionHeading>
          <p className="mb-2 text-zinc-600">
            <strong>They say:</strong> One product, millions of users.
          </p>
          <p className="mb-4 text-zinc-600">
            <strong>We say:</strong> One product, one person, multiplied by everyone.
          </p>
          <p className="mb-3 text-zinc-600">
            The SaaS Model optimizes for the average user. Personal Intelligence
            optimizes for you. There is no feature request backlog because your
            assistant can be shaped by you, for you, right now.
          </p>
          <p className="mb-1 text-sm text-zinc-500">
            <em>Today:</em> every SaaS company.
          </p>
          <p className="mb-0 text-sm text-zinc-500">
            <em>Dimension:</em> one-size-fits-all vs. one-size-fits-one
          </p>
        </section>

        <section id="article-viii-amendments" className="mt-12">
          <SectionHeading id="article-viii-amendments" level={2}>
            Article VIII. Amendments
          </SectionHeading>
          <Governs>
            How this document is versioned, stored, and changed over time.
          </Governs>

          <SectionHeading id="permanent-home" level={3}>
            Permanent Home
          </SectionHeading>
          <p className="mb-3 text-zinc-600">
            This document lives at <code>CONSTITUTION.md</code> in the{" "}
            <a href="https://github.com/vellum-ai/vellum-assistant" target="_blank" rel="noopener noreferrer" className="text-zinc-800 underline hover:text-zinc-950"><code>vellum-ai/vellum-assistant</code></a> open source repository, alongside <code>GLOSSARY.md</code> and
            other foundational materials of comparable weight.
          </p>
          <p className="mb-3 text-zinc-600">Housing it in a repo provides:</p>
          <ul className="mb-6 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              Full git history so every change is tracked, attributed, and reversible
            </li>
            <li>Pull request workflow so amendments require review and approval</li>
            <li>Readable by the whole company and the public</li>
          </ul>

          <SectionHeading id="amendment-process" level={3}>
            Amendment Process
          </SectionHeading>
          <p className="mb-3 text-zinc-600">
            If you disagree with something in this document, good. It means it is
            specific enough to be disagreed with. Here is how to change it:
          </p>
          <ol className="mb-0 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Propose.</strong> Identify the specific article you want to
              change and draft the proposed amendment with rationale.
            </li>
            <li>
              <strong>Review.</strong> At least three people from Vellum must review and align on
              the change, including at least one person from Vellum leadership.
            </li>
            <li>
              <strong>Ratify.</strong> The change is merged with a clear PR
              description: what changed, why, and who approved it.
            </li>
            <li>
              <strong>Communicate.</strong> Material changes are announced to the
              company. Policy changes are announced to our users. People should not
              discover constitutional shifts by stumbling across an edit.
            </li>
          </ol>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
