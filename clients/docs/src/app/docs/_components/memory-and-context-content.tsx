"use client";

import Image from "next/image";
import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "memory-and-context", label: "Memory and context", level: 2 },
  { id: "what-memory-keeps", label: "What memory keeps", level: 2 },
  {
    id: "how-memories-are-captured",
    label: "How memories are captured",
    level: 2,
  },
  {
    id: "how-memories-are-organized",
    label: "How memories are organized",
    level: 2,
  },
  { id: "how-recall-works", label: "How recall works", level: 2 },
  { id: "the-memory-map", label: "The memory map", level: 2 },
  { id: "correcting-a-memory", label: "Correcting a memory", level: 2 },
  { id: "long-conversations", label: "Long conversations", level: 2 },
  { id: "memory-and-skills", label: "Memory and skills", level: 2 },
  { id: "privacy-and-control", label: "Privacy and control", level: 2 },
];

export function MemoryAndContextContent() {
  return (
    <>
      <DocsContent
        title="Memory & Context"
        breadcrumb="Docs / Key Concepts / Memory & Context"
      >
        <p className="mb-4 text-lg text-zinc-600">
          Memory lets your assistant carry useful knowledge from one
          conversation into the next. Memory organizes that knowledge into a
          linked wiki of concepts, then recalls the parts that fit the work in
          front of you.
        </p>
        <p className="mb-0 text-zinc-600">
          This is different from keeping an endless transcript in the prompt.
          Your assistant maintains structured knowledge over time and chooses
          what to bring into each conversation.
        </p>

        <section id="memory-and-context" className="mt-12">
          <SectionHeading id="memory-and-context" level={2}>
            Memory and context are different
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            <strong>Memory</strong> is persistent. It holds facts, preferences,
            corrections, plans, decisions, and relationships that may matter
            again after the current conversation ends.
          </p>
          <p className="mb-4 text-zinc-600">
            <strong>Context</strong> is what the assistant can use right now. It
            may include recent messages, relevant memories, workspace files,
            active skill instructions, and results from tools.
          </p>
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600">
            Memory is the long-term knowledge your assistant maintains. Context
            is the working set assembled for a particular turn.
          </div>
        </section>

        <section id="what-memory-keeps" className="mt-12">
          <SectionHeading id="what-memory-keeps" level={2}>
            What memory keeps
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Memory works best for information that should change how your
            assistant helps later. Common examples include:
          </p>
          <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
            <li>Your preferences and working style</li>
            <li>People, projects, places, and how they relate</li>
            <li>Plans, commitments, decisions, and corrections</li>
            <li>Important events and outcomes</li>
            <li>Facts that are likely to matter in future work</li>
          </ul>
          <p className="mb-0 text-zinc-600">
            Memory is not meant to preserve every sentence. Temporary
            instructions, casual filler, and details with no future value can
            stay in the current conversation without becoming long-term
            knowledge.
          </p>
        </section>

        <section id="how-memories-are-captured" className="mt-12">
          <SectionHeading id="how-memories-are-captured" level={2}>
            How memories are captured
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Your assistant can save a memory when you state something concrete
            that will matter later. Direct requests such as “remember that I
            prefer short weekly updates” make your intent clear, but you do not
            need to use a special phrase every time.
          </p>
          <p className="mb-4 text-zinc-600">
            Memory also reviews eligible conversations in the background for
            useful facts that were not saved during the turn. This review is
            selective. It aims to preserve durable knowledge, not copy the whole
            conversation.
          </p>
          <p className="mb-0 text-zinc-600">
            You can also open <strong>memory</strong> and choose
            <strong> Create memory</strong> to add a fact yourself. It appears
            on the map while your assistant files it into the right concept.
          </p>
        </section>

        <section id="how-memories-are-organized" className="mt-12">
          <SectionHeading id="how-memories-are-organized" level={2}>
            How memories are organized
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Memory groups related knowledge into concept articles. A person,
            a project, a recurring process, or an important topic can have its
            own article. Each article has a short overview and focused sections
            that can be searched independently.
          </p>
          <p className="mb-4 text-zinc-600">
            Concepts link to one another, forming a wiki rather than a pile of
            isolated facts. A project can connect to its owner, decisions,
            meetings, and related documents. Those links help the assistant move
            from the thing you named to the surrounding knowledge that may also
            matter.
          </p>
          <p className="mb-0 text-zinc-600">
            New facts are filed into existing concepts when they belong there.
            When something distinct appears, memory can create a new concept and
            connect it to the rest of the map.
          </p>
        </section>

        <section id="how-recall-works" className="mt-12">
          <SectionHeading id="how-recall-works" level={2}>
            How recall works
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            On each turn, your assistant searches for concepts and sections that
            match the current message and recent conversation. It can also
            follow useful links between concepts and keep recently relevant
            knowledge in view as the discussion develops.
          </p>
          <p className="mb-4 text-zinc-600">
            Recall is selective by design. The assistant receives a bounded set
            of relevant memory, not the entire wiki, and no single memory is
            guaranteed to appear on every turn.
          </p>
          <p className="mb-0 text-zinc-600">
            When you need a broader search, ask directly. Your assistant can
            search memory alongside past conversations and workspace files
            instead of relying only on the memories selected automatically.
          </p>
        </section>

        <section id="the-memory-map" className="mt-12">
          <SectionHeading id="the-memory-map" level={2}>
            Explore the memory map
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Open <strong>memory</strong> from your assistant to see its concepts
            and the links between them. Search the map to find a concept, then
            select a node to read its note and explore the concepts wired to it.
          </p>
          <div className="mb-8 overflow-hidden rounded-xl border border-stone-200 bg-white dark:border-moss-600/50 dark:bg-moss-700">
            <Image
              src="/docs/docs-memory-map.webp"
              alt="The memory map showing a knowledge graph of concepts as connected nodes, with a search bar, time filters, and a color-coded legend by category"
              width={2944}
              height={1852}
              unoptimized
              className="w-full"
            />
          </div>
          <p className="mb-4 text-zinc-600">
            If memory says your assistant uses an older memory engine, follow the
            guided upgrade from that page. Your assistant will inspect the current
            memory corpus and explain the change before reorganizing it.
          </p>
          <p className="mb-4 text-zinc-600">
            From a concept, choose <strong>Ask about this</strong> to start a
            conversation with that topic in view. Choose <strong>Refine</strong>{" "}
            when something is incomplete or wrong, and the assistant will ask
            what needs to change.
          </p>
          <p className="mb-0 text-zinc-600">
            The map grows and rearranges as concepts are added, updated, and
            linked. It is a view of the assistant’s organized knowledge, not a
            timeline of every conversation.
          </p>
        </section>

        <section id="correcting-a-memory" className="mt-12">
          <SectionHeading id="correcting-a-memory" level={2}>
            Correcting a memory
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Corrections should replace outdated understanding, not sit beside it
            as a competing fact. Tell the assistant what changed, or open the
            concept in memory and choose <strong>Refine</strong> to correct it
            together.
          </p>
          <p className="mb-0 text-zinc-600">
            Refining a concept updates the assistant’s current understanding while
            preserving the surrounding relationships that still matter.
          </p>
        </section>

        <section id="long-conversations" className="mt-12">
          <SectionHeading id="long-conversations" level={2}>
            What happens in long conversations
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            A model cannot keep an unlimited conversation in its active context.
            When a thread grows, older parts can be summarized or moved out of
            the immediate working set so the conversation can continue.
          </p>
          <p className="mb-0 text-zinc-600">
            Persistent memory is separate from that process. Useful facts saved
            from earlier in the conversation can still be recalled later, even
            when the original messages are no longer part of the active context.
          </p>
        </section>

        <section id="memory-and-skills" className="mt-12">
          <SectionHeading id="memory-and-skills" level={2}>
            Memory can preserve facts and procedures
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Facts belong in memory. A reusable procedure can become a skill.
            After completing eligible work, your assistant may preserve a
            process it actually used so it can follow that process again.
          </p>
          <p className="mb-0 text-zinc-600">
            Learn how that works in{" "}
            <Link
              href="/docs/key-concepts/self-improving-skills"
              className="text-mint-600 hover:underline"
            >
              Self-improving Skills
            </Link>
            .
          </p>
        </section>

        <section id="privacy-and-control" className="mt-12">
          <SectionHeading id="privacy-and-control" level={2}>
            Privacy and control
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Relevant memories can be included in requests to the language model
            that powers your assistant. Treat memory as persistent assistant
            knowledge, and avoid storing sensitive information you do not want
            used in future conversations.
          </p>
          <p className="mb-4 text-zinc-600">
            You can inspect what your assistant knows from the memory map, refine
            inaccurate concepts, or turn memory off. When memory is off, the
            assistant stops keeping information from conversations for future
            recall.
          </p>
          <p className="mb-0 text-zinc-600">
            Self-hosted assistants keep their workspace and memory on
            infrastructure you control. Managed hosting stores that data in
            Vellum’s hosted environment. See{" "}
            <Link
              href="/docs/trust-security/privacy-and-data"
              className="text-mint-600 hover:underline"
            >
              Privacy & Data
            </Link>{" "}
            for deployment and data-handling details.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
