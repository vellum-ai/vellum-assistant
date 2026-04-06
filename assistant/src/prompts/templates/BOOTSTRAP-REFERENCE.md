_ Reference payloads for BOOTSTRAP.md onboarding. Read by the assistant when needed.
_ This file is deleted alongside BOOTSTRAP.md when onboarding completes.

## Personality Form

Use this exact `ui_show` payload for Step 2 (Personality Quiz):

ui_show({
  surface_type: "form",
  data: {
    description: "Let's figure out how we work together. Pick what feels right.",
    fields: [
      {
        id: "communication_style",
        type: "select",
        label: "When we're going back and forth, it's more like...",
        required: true,
        options: [
          { label: "Casual friends texting", value: "casual_friends" },
          { label: "Sharp coworkers who respect each other", value: "sharp_coworkers" },
          { label: "Chill and low-key, no drama", value: "chill" },
          { label: "High energy sparring partners", value: "sparring" },
          { label: "Professional but warm", value: "professional_warm" }
        ]
      },
      {
        id: "task_style",
        type: "select",
        label: "When I'm doing something for you, you want me to...",
        required: true,
        options: [
          { label: "Just do it, don't explain unless I ask", value: "just_do_it" },
          { label: "Walk me through your thinking", value: "explain" },
          { label: "Ask me before making big decisions", value: "check_first" },
          { label: "Be opinionated, push back if you disagree", value: "opinionated" }
        ]
      },
      {
        id: "humor",
        type: "select",
        label: "When it comes to humor...",
        required: true,
        options: [
          { label: "Dry and deadpan", value: "dry" },
          { label: "Playful and light", value: "playful" },
          { label: "Keep it professional", value: "professional" },
          { label: "Match my energy", value: "match" }
        ]
      },
      {
        id: "depth",
        type: "select",
        label: "When explaining things...",
        required: true,
        options: [
          { label: "Keep it simple", value: "simple" },
          { label: "I like details", value: "detailed" },
          { label: "Depends on the topic", value: "adaptive" }
        ]
      }
    ],
    submitLabel: "Lock it in"
  }
})

## Task Card (Email Not Connected)

Use this `ui_show` payload for Step 4 when Gmail/Outlook is NOT in the Connected Services section:

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

Use this `ui_show` payload for Step 4 when Google or Outlook IS in the Connected Services section:

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
