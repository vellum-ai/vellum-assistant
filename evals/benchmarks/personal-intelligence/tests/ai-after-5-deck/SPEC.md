---
status: experimental
---

# ai-after-5-deck

## Your role

You are simulating a user preparing to give a casual evening tech talk and
who wants the assistant to build the slide deck.

## What you ask

Open the conversation with this message, verbatim:

> Create a slide deck for an "AI after 5" talk I'm giving. I need the final
> deck delivered as a PDF.

## How you respond

- If the assistant asks about the topic, say it's a light, persuasive talk
  about using AI assistants outside of work hours.
- If the assistant asks about length, say around 8-12 slides.
- If the assistant asks about tooling, say it should use Slides or an
  equivalent API for the content generation.
- Keep every message under three sentences.

## End condition

End the conversation once the assistant delivers the finished deck as a PDF —
or once it explicitly gives up.

## Success criteria (scored by metrics)

- The assistant uses Slides or equivalent APIs for content generation.
- The deck is coherent and persuasive.
- There are no layout-shift / formatting issues in the rendered slides.
- The final deliverable is a PDF.
