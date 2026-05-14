_ Optional reference payloads. The model may use these if it chooses to show a task card, but is not required to.
_ This file is deleted alongside BOOTSTRAP.md when onboarding completes.

## Task Card (Email Not Connected)

Use this `ui_show` payload when Gmail/Outlook is NOT in the Connected Services section:

ui_show({
  surface_type: "card",
  data: {
    title: "Pick something. I'll do it right now.",
    body: "These are real, not demos."
  },
  actions: [
    { id: "relay_prompt", label: "Connect my email", data: { prompt: "I'd like to connect my Gmail or Outlook so you can help me manage my email and calendar" } },
    { id: "relay_prompt", label: "Research a topic and make me a deck", data: { prompt: "I'd like you to research a topic for me and turn it into a visual deck" } },
    { id: "relay_prompt", label: "Build me something", data: { prompt: "Help me build a simple interactive app or tool" } },
    { id: "relay_prompt", label: "Do something with a photo", data: { prompt: "I have a photo I'd like you to analyze, edit, or create something from" } }
  ]
})

## Task Card (Email Already Connected)

Use this `ui_show` payload when Google or Outlook IS in the Connected Services section.

When the `google-connect-scan` feature flag is enabled and `googleConnected: true` is present in the onboarding context, skip this card entirely — the Google integration scan (GOOGLE_CONNECT_SCAN.md) replaces the static suggestions below. The scan will produce personalized, actionable insights from the user's actual email and calendar data instead of generic prompts.

When the flag is off, or for non-Google email providers, use this card as before:

ui_show({
  surface_type: "card",
  data: {
    title: "Pick something. I'll do it right now.",
    body: "These are real, not demos."
  },
  actions: [
    { id: "relay_prompt", label: "Check my email", data: { prompt: "Check my email and calendar and give me a summary of what's going on" } },
    { id: "relay_prompt", label: "Research a topic and make me a deck", data: { prompt: "I'd like you to research a topic for me and turn it into a visual deck" } },
    { id: "relay_prompt", label: "Build me something", data: { prompt: "Help me build a simple interactive app or tool" } },
    { id: "relay_prompt", label: "Do something with a photo", data: { prompt: "I have a photo I'd like you to analyze, edit, or create something from" } }
  ]
})
