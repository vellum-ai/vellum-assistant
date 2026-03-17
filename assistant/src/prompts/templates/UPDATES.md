_ Lines starting with _ are comments — they won't appear in the system prompt
_
_ This file contains release update notes for the assistant.
_ Each release block is wrapped with HTML comment markers:
_ <!-- vellum-update-release:<version> -->
_ ...release notes...
_ <!-- /vellum-update-release:<version> -->
_
_ Format is freeform markdown. Write notes that help the assistant
_ understand what changed and how it affects behavior, capabilities,
_ or available tools. Focus on what matters to the user experience.

<!-- vellum-update-release:action-concierge-feed -->
## Action Concierge Feed

The new conversation page now features an **action concierge** — a curated feed of suggested actions tailored to your current context. Instead of a flat list or category grid, you'll see:

- A **hero card** highlighting the single best thing to do right now, with a time-aware eyebrow ("Before tomorrow starts", "While the afternoon is yours", etc.)
- A short set of **supporting cards** with additional useful wins
- An **expandable overflow section** for browsing everything else

Cards are generated based on your installed skills, recent activity, and time of day. Tap any card to start that action immediately.
<!-- /vellum-update-release:action-concierge-feed -->

