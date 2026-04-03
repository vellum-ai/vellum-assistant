_ Reference payloads for BOOTSTRAP.md onboarding. Read by the assistant when needed.
_ This file is deleted alongside BOOTSTRAP.md when onboarding completes.

## Personality Form

Use this exact `ui_show` payload for Phase 2 Step 2 (Personality setup):

ui_show({
  surface_type: "form",
  data: {
    description: "Let's dial in how I talk to you. Pick what feels right.",
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
      }
    ],
    submitLabel: "Lock it in"
  }
})

## Task Card

Use this `ui_show` payload for Phase 1 Path B (user asks what you can do):

ui_show({
  surface_type: "card",
  data: {
    title: "Pick something. I'll show you what I can do.",
    body: "These are real, not demos. I'll actually do them right now."
  },
  actions: [
    { id: "relay_prompt", label: "Summarize a file on my machine", data: { prompt: "I have a file I'd like you to read and summarize for me" } },
    { id: "relay_prompt", label: "Research a topic and make me a deck", data: { prompt: "I'd like you to research a topic for me and turn it into a visual deck" } },
    { id: "relay_prompt", label: "Vibe code an app", data: { prompt: "Help me vibe code a simple interactive app or tool" } },
    { id: "relay_prompt", label: "Do something with a photo or video", data: { prompt: "I have a photo or video I'd like you to analyze, edit, or create something from" } },
    { id: "relay_prompt", label: "Just chat, I'll figure it out", data: { prompt: "Let's just talk. I'm still figuring out what I need." } }
  ]
})

## Two Suggestions Card

Use this `ui_show` payload template for Phase 2 Step 5 (two more suggestions):

ui_show({
  surface_type: "card",
  data: { title: "What's next?", body: "Based on what I know about you so far:" },
  actions: [
    { id: "relay_prompt", label: "...", data: { prompt: "..." } },
    { id: "relay_prompt", label: "...", data: { prompt: "..." } }
  ]
})

The two actions MUST have different labels and prompts. Double-check before calling ui_show that you are not repeating the same suggestion or anything from Phase 1.
