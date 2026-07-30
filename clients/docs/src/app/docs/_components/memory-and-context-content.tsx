"use client";

import Image from "next/image";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "three-layers-of-memory", label: "Three layers of memory", level: 2 },
  { id: "workspace-files-the-baseline", label: "1. Workspace files: the baseline", level: 3 },
  { id: "knowledge-base-the-curated-layer", label: "2. Knowledge base: the curated layer", level: 3 },
  { id: "long-term-memory", label: "3. Long-term memory: the auto-extracted layer", level: 3 },
  { id: "kinds-of-memory", label: "Kinds of memory", level: 2 },
  { id: "how-it-decides-what-to-remember", label: "How it decides what to remember", level: 2 },
  { id: "how-it-corrects-itself", label: "How it corrects itself", level: 2 },
  { id: "procedural-memory-as-skills", label: "Procedural memory as skills", level: 2 },
  { id: "how-context-works-in-a-conversation", label: "How context works in a conversation", level: 2 },
  { id: "how-memory-recall-works", label: "How memory recall works", level: 2 },
  { id: "the-injection-gate", label: "The injection gate", level: 2 },
  { id: "what-happens-when-conversations-get-long", label: "What happens when conversations get long", level: 2 },
  { id: "private-conversations", label: "Private conversations", level: 2 },
  { id: "trust-and-memory", label: "Trust and memory", level: 2 },
  { id: "the-memory-inspector", label: "The memory inspector", level: 2 },
  { id: "privacy", label: "Privacy", level: 2 },
];

export function MemoryAndContextContent() {
  return (
    <>
      <DocsContent title="Memory & Context" breadcrumb="Docs / Key Concepts / Memory & Context">
        <p className="mb-8 text-zinc-600">
          Your assistant remembers you. Not just within a single conversation,
          but across days, weeks, and months. Here&apos;s how.
        </p>

        <div className="mb-12 overflow-hidden rounded-xl border border-stone-200 bg-white dark:border-moss-600/50 dark:bg-moss-700">
          <Image
            src="/docs/docs-memory-lifecycle.webp"
            alt="Diagram of the Vellum memory lifecycle. Step 1 Conversation: you and your assistant talking across chat, voice, or mobile. Step 2 Extraction: after each chat, an LLM pulls out what matters and creates, updates, or reinforces memories. Step 3 Memory graph: memories are nodes connected by labeled edges, with kinds shown as Event, Feeling, Knowledge, Plan, and Pattern, plus a decay and reinforcement note. Step 4 Recall: in the next conversation, relevant memories surface automatically. A continuous loop arrow runs back from Recall into Conversation."
            width={1323}
            height={791}
            unoptimized
            className="w-full"
          />
        </div>

        <section id="three-layers-of-memory">
          <SectionHeading id="three-layers-of-memory" level={2}>
            Three layers of memory
          </SectionHeading>
          <p className="mb-6 text-zinc-600">
            Your assistant has three ways of remembering things, each with a
            different purpose and lifetime.
          </p>

          <div id="workspace-files-the-baseline" className="mb-10">
            <SectionHeading id="workspace-files-the-baseline" level={3}>
              1. Workspace files: the baseline
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              A handful of plain-text files at the root of your workspace
              define the constants:
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li>
                <strong>essentials.md</strong>: facts that would be
                embarrassing to forget: your name, your co-founder&apos;s
                name, that you&apos;re allergic to penicillin. The most
                expensive things to forget live here.
              </li>
              <li>
                <strong>threads.md</strong>: your assistant&apos;s
                open loops: active commitments, follow-ups in progress,
                things waiting on a response
              </li>
              <li>
                <strong>recent.md</strong>: what happened today and
                yesterday. Fades out naturally as the consolidation job runs.
              </li>
              <li>
                <strong>buffer.md</strong>: every fact your assistant
                decides to remember lands here first, raw and unfiled, until
                the consolidation pass decides what to do with it
              </li>
            </ul>
            <p className="mb-0 text-zinc-600">
              These four files are loaded into every conversation. They&apos;re
              the foundation: the context that makes it feel like it
              knows you before you&apos;ve said a word. You can edit them
              directly at any time.
            </p>
          </div>

          <div id="knowledge-base-the-curated-layer" className="mb-10">
            <SectionHeading id="knowledge-base-the-curated-layer" level={3}>
              2. Knowledge base: the curated layer
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              The knowledge base, or PKB, lives in <code>pkb/</code> at the
              root of your workspace. It&apos;s a set of markdown notes your
              assistant maintains about you, your work, your projects, and
              anything else worth remembering at a higher level than a single
              fact.
            </p>
            <p className="mb-0 text-zinc-600">
              Where workspace files define constants and long-term memory
              captures atomic facts, the knowledge base is the in-between
              layer: longer-form, organized, human-readable. Your assistant
              files things here when a topic deserves more than a single
              memory entry, and pulls relevant notes back into context when
              they apply. You can open <code>pkb/INDEX.md</code> to browse
              what&apos;s in there, or edit any file directly.
            </p>
          </div>

          <div id="long-term-memory">
            <SectionHeading id="long-term-memory" level={3}>
              3. Long-term memory: the auto-extracted layer
            </SectionHeading>
            <p className="mb-0 text-zinc-600">
              Beyond workspace files and the knowledge base, your assistant
              has a memory system that works more like human memory. It
              extracts facts and moments from your conversations and stores
              them as searchable, categorized items, each with a confidence
              score, an importance rating, a source type (told directly,
              observed, inferred), and a reinforcement count that grows every
              time the same memory comes up again. See the next section for
              the kinds of memory it tracks.
            </p>
          </div>
        </section>

        <section id="kinds-of-memory" className="mt-12">
          <SectionHeading id="kinds-of-memory" level={2}>
            Kinds of memory
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            The memory system is modeled loosely on the cognitive science
            picture of human memory. Each memory has a <em>kind</em> that
            tells the assistant what it is, how to file it, and how to bring
            it back later.
          </p>
          <div className="mb-4 overflow-hidden rounded-xl border border-zinc-200">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">
                    Kind
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">
                    What it captures
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-zinc-500">
                    Example
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-zinc-50">
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Event</td>
                  <td className="px-4 py-3 text-zinc-600">
                    Specific things that happened, with a time and place
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    &ldquo;Shipped v0.7.0 today&rdquo;
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Knowledge</td>
                  <td className="px-4 py-3 text-zinc-600">
                    Stable facts about you, your work, or the world
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    &ldquo;Alice works at Vellum as a GTM Engineer&rdquo;
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Feeling</td>
                  <td className="px-4 py-3 text-zinc-600">
                    Emotional moments, with intensity and valence that fade
                    over time
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    &ldquo;Felt great after the demo went well&rdquo;
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Plan</td>
                  <td className="px-4 py-3 text-zinc-600">
                    Intentions, goals, and upcoming things
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    &ldquo;Wants to publish the AI memory article next week&rdquo;
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Pattern</td>
                  <td className="px-4 py-3 text-zinc-600">
                    Recurring habits, preferences, or ways of working
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    &ldquo;Prefers paragraphs over bullet lists&rdquo;
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Story</td>
                  <td className="px-4 py-3 text-zinc-600">
                    Connected narratives that span multiple events
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    &ldquo;The arc of building Bob over the past month&rdquo;
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium text-zinc-800">Shared</td>
                  <td className="px-4 py-3 text-zinc-600">
                    Information involving someone other than you (a contact, a
                    teammate)
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    &ldquo;Sidd is the CTO at Vellum&rdquo;
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-0 text-zinc-600">
            There&apos;s also a system-managed kind called <strong>Skill</strong>{" "}
            that records what your assistant has learned about how to do
            things. You won&apos;t edit those directly: they&apos;re
            surfaced on the Skills tab instead. See <a href="#procedural-memory-as-skills" className="underline">procedural memory as skills</a>{" "}
            for how they get written.
          </p>
        </section>

        <section id="how-it-decides-what-to-remember" className="mt-12">
          <SectionHeading id="how-it-decides-what-to-remember" level={2}>
            How it decides what to remember
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Your assistant doesn&apos;t save everything. After each message,
            it runs an extraction step that identifies things worth keeping,
            assigns each one a kind, and tags it with confidence, importance,
            and a source type (told directly, observed, inferred, or told by
            someone else).
          </p>
          <p className="mb-3 text-zinc-600">It extracts when:</p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>You share a personal fact or preference</li>
            <li>You make a decision worth tracking</li>
            <li>It learns something non-obvious from a task</li>
            <li>You correct its behavior</li>
            <li>Something seems important for future interactions</li>
          </ul>
          <p className="mb-4 text-zinc-600">
            Low-value messages (&ldquo;ok,&rdquo; &ldquo;thanks,&rdquo;
            &ldquo;got it&rdquo;) are filtered out before extraction even
            runs. The system errs on the side of remembering too little
            rather than too much, and a fingerprint check prevents the same
            fact from being saved twice. Instead, repeats reinforce
            the existing memory.
          </p>
          <p className="mb-4 text-zinc-600">
            If you want it to remember something specific, just say so:
          </p>
          <blockquote className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &ldquo;Remember that my dentist appointment is on March
            15th.&rdquo;
          </blockquote>
          <blockquote className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-zinc-700">
            &ldquo;Save this: the project deadline is end of Q2.&rdquo;
          </blockquote>
          <p className="mb-4 text-zinc-600">
            Explicit asks land with high confidence, which makes them less
            likely to be superseded or to drop out of recall later.
          </p>
          <p className="mb-0 text-zinc-600">
            Every four hours, the assistant runs a consolidation pass. It
            walks through the buffer, decides what gets filed into a concept
            page, what gets promoted to{" "}
            <code>essentials.md</code>, what gets merged with existing
            entries, and what gets discarded. There are no hard-coded rules:
            your assistant uses its own judgement, the same
            compression a brain does during sleep.
          </p>
        </section>

        <section id="how-it-corrects-itself" className="mt-12">
          <SectionHeading id="how-it-corrects-itself" level={2}>
            How it corrects itself
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            When the assistant extracts a new fact that contradicts an older
            one (you told it you preferred coffee last month but
            mentioned you&apos;ve switched to tea), the new memory can
            supersede the old one. If the correction is explicit
            (&ldquo;Actually, I prefer tea now&rdquo;), it&apos;s treated as
            high salience and fast-tracked straight into{" "}
            <code>essentials.md</code>, where it&apos;s guaranteed to be in
            context for every conversation that follows. A supersession link
            is recorded so the history stays intact. If the contradiction is
            inferred, both can coexist until one wins out through
            reinforcement.
          </p>
          <p className="mb-0 text-zinc-600">
            Memories that come up across multiple conversations grow more
            stable over time and are less likely to be displaced. Memories
            that go quiet for long stretches lose stability and get demoted
            in recall before eventually dropping out.
          </p>
        </section>

        <section id="procedural-memory-as-skills" className="mt-12">
          <SectionHeading id="procedural-memory-as-skills" level={2}>
            Procedural memory as skills
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Facts are only half of what&apos;s worth keeping. The other
            half is know-how: the multi-step procedures your assistant
            figures out while completing work for you. The first time it
            publishes your podcast episode, it might spend a dozen steps
            discovering where the audio lives, which export settings work,
            and the one flag that fixes the stereo mix. Without procedural
            memory, that discovery cost gets paid again from scratch the
            next time you ask.
          </p>
          <p className="mb-4 text-zinc-600">
            So your assistant saves procedures as skills. During the same
            background review passes that extract facts, it looks for a
            procedure it actually carried out (steps it executed, not
            something it merely discussed or planned) that seems worth
            reusing. When it finds one, it writes a skill in the same
            format as the skills you install: a name, a description,
            step-by-step instructions, and companion notes capturing what
            it learned the hard way (errors it hit and how it recovered,
            plus the paths, IDs, and settings that held steady).
          </p>
          <p className="mb-4 text-zinc-600">
            Each self-authored skill carries <strong>activation hints</strong>:
            the situations that should trigger it, phrased as intent
            (&ldquo;user asks to publish an episode&rdquo;) rather than as
            mechanical steps. Those hints become the skill&apos;s retrieval
            signal, so a future request surfaces it even when your wording
            doesn&apos;t match its name. Skills can also carry avoid-when
            notes for situations where they shouldn&apos;t be used.
          </p>
          <p className="mb-4 text-zinc-600">
            Self-authored skills stay in their lane. Before writing
            anything, your assistant searches for existing skills that
            already cover the procedure. It will refine and rewrite skills
            it authored itself as it finds better ways to do the job, but
            it never overwrites, shadows, or duplicates a skill that you
            wrote, that you installed, or that shipped with the assistant.
            If one of those already covers the procedure, it leaves it
            alone.
          </p>
          <p className="mb-0 text-zinc-600">
            From there they behave like any other skill. They surface
            through the same recall pipeline as memories, so when a
            request matches, the assistant follows the proven path instead
            of rediscovering it. They appear on the Skills tab alongside
            installed skills, where you can read exactly what was learned,
            edit it, or delete it. Ordinary facts still flow through
            regular memory; skills are reserved for procedures.
          </p>
        </section>

        <section id="how-context-works-in-a-conversation" className="mt-12">
          <SectionHeading id="how-context-works-in-a-conversation" level={2}>
            How context works in a conversation
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Every time you send a message, your assistant assembles context
            from multiple sources:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Working memory files</strong>: essentials.md,
              threads.md, recent.md, and buffer.md, loaded at the start of
              every conversation
            </li>
            <li>
              <strong>Knowledge base entries</strong>: relevant notes
              from <code>pkb/</code>, pulled in when they apply to what
              you&apos;re asking
            </li>
            <li>
              <strong>Conversation history</strong>: everything said
              so far in this session (summarized if it gets long)
            </li>
            <li>
              <strong>Memory recall</strong>: a search of long-term
              memory for anything relevant to your message
            </li>
            <li>
              <strong>Active skill instructions</strong>: if a skill
              is loaded, its instructions are included
            </li>
            <li>
              <strong>Your message</strong>: what you just said,
              including any attached images
            </li>
          </ol>
          <p className="mb-0 text-zinc-600">
            All of this gets sent to the AI model together. That&apos;s how
            your assistant responds with awareness of who you are, what
            you&apos;ve discussed before, and what&apos;s relevant right
            now.
          </p>
        </section>

        <section id="how-memory-recall-works" className="mt-12">
          <SectionHeading id="how-memory-recall-works" level={2}>
            How memory recall works
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            When you send a message, the assistant doesn&apos;t just do a
            keyword search. It runs a hybrid retrieval pipeline:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Your message is embedded</strong>: converted
              into both a dense vector (capturing meaning) and a sparse
              vector (capturing keywords)
            </li>
            <li>
              <strong>Both vectors search the memory store</strong>:
              BM25 (keyword matching) finds exact matches, dense embeddings
              find semantic matches. A PCA step corrects for embedding
              anisotropy so results aren&apos;t skewed by high-frequency
              directions in the embedding space.
            </li>
            <li>
              <strong>Spreading activation</strong>: the top matches
              kick off a graph traversal. Neighboring concept pages get a
              relevance boost, so adjacent context arrives automatically:
              a memory about a project also surfaces the people,
              deadlines, and related events connected to it.
            </li>
            <li>
              <strong>Summaries first</strong>: concept page summaries
              load by default. Full page bodies are fetched only when the
              summary suggests they&apos;re relevant, keeping token usage
              proportional to what actually matters.
            </li>
            <li>
              <strong>Scoring</strong>: each result gets a composite
              score combining semantic relevance, recency (using a
              logarithmic decay so older memories aren&apos;t wiped out too
              fast), reinforcement count, and extraction confidence
            </li>
            <li>
              <strong>Stability check</strong>: memories with low
              stability or past their natural lifetime get demoted, even if
              they scored well on relevance
            </li>
            <li>
              <strong>Two-layer injection</strong>: relevant memories
              are formatted and inserted as structured context, split into
              an identity/preference layer (who you are) and a general
              context layer (everything else)
            </li>
          </ol>
          <p className="mb-0 text-zinc-600">
            The budget for memory injection is dynamic: it expands or
            contracts based on how much room is left in the context window
            after workspace files, conversation history, and skill
            instructions.
          </p>
        </section>

        <section id="the-injection-gate" className="mt-12">
          <SectionHeading id="the-injection-gate" level={2}>
            The injection gate
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Recall has a quiet failure mode: search always returns
            something. Ask &ldquo;what&apos;s 18% of 240?&rdquo; and the
            pipeline still produces a ranked list of memories; the top of
            that list is just whatever scored least badly. Injecting those
            weak matches wastes context and can nudge the reply toward
            memories that have nothing to do with the question.
          </p>
          <p className="mb-3 text-zinc-600">
            The injection gate is a per-message check that sits between
            search and injection. Once retrieval has scored its
            candidates, the gate reads those scores and decides whether
            there&apos;s enough signal to inject memories at all. It opens
            in three cases:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>A strong semantic match.</strong> The best result
              clears a similarity bar on meaning alone.
            </li>
            <li>
              <strong>A coherent neighborhood.</strong> No single result
              clears the bar, but the top few sit tightly grouped just
              beneath it. That shape usually means your message really is
              about that region of memory, just phrased in a way no single
              page matches head-on.
            </li>
            <li>
              <strong>A strong keyword match.</strong> Meaning-based
              search came up short, but an exact term match is convincing
              on its own. Keyword-only signal is held to a higher bar than
              semantic signal.
            </li>
          </ul>
          <p className="mb-4 text-zinc-600">
            One rule is absolute: if not a single search term matched
            anything, the keyword side can never open the gate, no matter
            how the thresholds are tuned.
          </p>
          <p className="mb-4 text-zinc-600">
            When the gate stays closed, the message skips memory injection
            entirely, which also skips the model pass that decides which
            memories to include. Low-signal turns get faster and cheaper,
            and the reply stays focused on what you actually asked. Your
            workspace files and everything already established in the
            conversation are untouched; the assistant simply doesn&apos;t
            reach for new memories when nothing relevant is there.
            (Depending on configuration, a closed gate can still keep the
            assistant&apos;s always-on core pages in play.) The gate also
            fails open: if the check itself hits an error, the assistant
            falls back to normal recall rather than dropping memories.
          </p>
          <p className="mb-0 text-zinc-600">
            The gate is rolling out gradually and is currently off by
            default, with thresholds tuned per assistant.
          </p>
        </section>

        <section id="what-happens-when-conversations-get-long" className="mt-12">
          <SectionHeading id="what-happens-when-conversations-get-long" level={2}>
            What happens when conversations get long
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Every AI model has a context window, a limit on how much
            text it can process at once. Your assistant manages this
            automatically:
          </p>
          <ol className="mb-4 list-decimal space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Compaction</strong>: when the conversation
              approaches 80% of the context limit, older messages are
              summarized into a compact form. The summary preserves goals,
              decisions, constraints, file paths, errors, and open questions
              while dropping filler and repetition.
            </li>
            <li>
              If that&apos;s not enough, tool results are truncated
              to their essentials.
            </li>
            <li>
              If still tight, images and file contents are replaced
              with text descriptions.
            </li>
            <li>
              Last resort: memory injection is scaled back to recent
              items only.
            </li>
          </ol>
          <p className="mb-4 text-zinc-600">
            You won&apos;t notice this happening. The assistant keeps the
            conversation going smoothly: it just works with a
            summarized version of the earlier context rather than the full
            transcript.
          </p>
          <p className="mb-0 text-zinc-600">
            You can also trigger compaction manually with{" "}
            <code>/compact</code> at any time, and a context window indicator
            in the toolbar shows how much space is left.
          </p>
        </section>

        <section id="private-conversations" className="mt-12">
          <SectionHeading id="private-conversations" level={2}>
            Private conversations
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            You can start a private conversation that gets its own isolated
            memory scope. Memories from a private conversation:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              <strong>Can&apos;t leak out</strong>: they won&apos;t
              surface in other conversations
            </li>
            <li>
              <strong>Can read in</strong>: the private conversation
              can still access your shared memory pool
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            This is useful when you&apos;re discussing something sensitive.
            The assistant learns from the conversation, but those memories
            stay contained to that scope.
          </p>
        </section>

        <section id="trust-and-memory" className="mt-12">
          <SectionHeading id="trust-and-memory" level={2}>
            Trust and memory
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Not everyone who talks to your assistant can shape its memories.
            Memory extraction only runs on messages from trusted actors:
            that&apos;s you (the guardian). Messages from trusted
            contacts or unknown parties are indexed for search within that
            conversation, but they can&apos;t create or modify your
            long-term memories.
          </p>
          <p className="mb-0 text-zinc-600">
            This prevents external parties from injecting false facts into
            your assistant&apos;s memory.
          </p>
        </section>

        <section id="the-memory-inspector" className="mt-12">
          <SectionHeading id="the-memory-inspector" level={2}>
            The memory inspector
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Open <strong>About your assistant &rarr; Memories</strong> to browse
            everything your assistant has filed. The inspector lets you:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>
              Filter by kind (Event, Knowledge, Feeling, Plan, Pattern,
              Story, Shared)
            </li>
            <li>
              See each memory&apos;s confidence, importance, source type,
              and reinforcement count
            </li>
            <li>
              Search across all memories, including inactive ones
            </li>
            <li>
              Edit a memory, mark it inactive, or delete it: deleted
              memories can be recovered
            </li>
            <li>
              Trace supersession links: see which memory replaced which
            </li>
          </ul>
          <p className="mb-0 text-zinc-600">
            You can also do this conversationally: ask what your
            assistant remembers about a topic, correct it, or tell it to
            forget something specific.
          </p>
        </section>

        <section id="privacy" className="mt-12">
          <SectionHeading id="privacy" level={2}>
            Privacy
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Memories are stored in your private workspace, in a SQLite
            database for the structured records and a Qdrant vector store
            for the embeddings. On Vellum Cloud, that workspace lives
            encrypted in your account; on self-hosted installations, it
            lives on your machine inside <code>~/.vellum/workspace/data/</code>.
            Memories aren&apos;t shared with other users or used to train
            AI models.
          </p>
          <p className="mb-4 text-zinc-600">
            Memories are included in the context sent to the AI model when
            they&apos;re relevant to a conversation. This is how your
            assistant &ldquo;thinks&rdquo; with your context. Private
            storage, cloud thinking, the same trade-off as everywhere else
            in the system.
          </p>
          <p className="mb-0 text-zinc-600">
            If you tell your assistant something sensitive, it may extract
            it as a memory and include it in future AI model calls when
            relevant. You can ask it to forget specific things, edit your
            workspace files directly, manage memories from the inspector,
            or use private conversations to keep sensitive context
            isolated.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
