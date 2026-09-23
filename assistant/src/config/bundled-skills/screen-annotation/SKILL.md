---
name: screen-annotation
description: Point at things on the screen the user is showing you
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🫵"
  vellum:
    display-name: "Screen Annotation"
    category: "system"
    activation-hints:
      - "User asks where a control is, or to be walked through doing something themselves, in an app they share"
      - "User wants to be shown, not have it done for them"
      - "The answer is a place on the user's screen"
    avoid-when:
      - "User asks the assistant to do it (click, type, edit), even on a call: use computer-use"
      - "Nothing is being shared, so there is no surface to point at"
---

Drawing on the screen the user is showing you, so they can go and do the
thing themselves.

This is the opposite errand from computer use. Nothing here clicks, types or
drives anything: the marks are a way of pointing while you talk, for someone
who wants to learn where a control is rather than have it operated for them.
A mark is drawn clear of what it indicates and never takes the mouse, so
what you point at stays visible and clickable the whole time.

## Requires a screen share

Marks are drawn on the frame around the surface the user is sharing with the
call. With nothing shared there is nowhere to draw, and `screen_point_at`
fails saying so. Ask them to share their screen from the call, then point.

## Say what to point at

**Prefer naming the thing for an arrow.**
`{"target": "color balance", "caption": "Click this"}`.
The name is looked up on the surface itself, which knows where its controls
actually are, and an arrow is drawn at it.

**The label, not a description of it.** What is matched is the control's own
name. Casing, spacing and punctuation are forgiven, so `Color Balance` finds
`color balance`; nothing beyond that is, so "the stabilization button" finds
nothing, because no control is called that. Give the label on its own:
`stabilization`, `Send`, `Search`.

The arrow points at the middle of the control and stops just short, so what
you are sending someone to stays visible the whole time.

You are answered with what was drawn and the accessibility name it resolved
to. Some apps expose internal names such as `ToolbarExportControl` instead of
the visible label. When a returned name identifies the intended control in
the shared image, use that exact name as `target`; use the visible label in
the caption and speech. Do not invent an internal name or choose an unclear
candidate.

A failed name lookup draws nothing. It means the accessibility name could
not be resolved, not that the control is absent from the picture. Read the
returned names and retry with an exact name when it identifies the intended
control. Do not cycle through invented internal names.

**Use the picture when names cannot identify the control.** If the intended
control is clearly visible in a fresh image of the shared surface, retry in
the same turn with tight `x`/`y`/`width`/`height` bounds measured from that
image. This also applies when accessibility information is missing or a name
matches multiple controls. A failed name lookup does not require the user to
ask again before you can draw a ring.

If you cannot confidently locate the intended control, get a fresh view or
ask the user to clarify. Describe its location verbally only when you can
identify it. Do not invent a location or claim a mark was drawn after a
failed tool call.

## Coordinates, for a ring

Use bounds for a region, a visual fallback after a failed name lookup, or an
explicit request to circle a clearly visible control. When the user asks for
a circle or ring, use bounds directly; a named lookup draws an arrow. The
same requirement to identify the target in a fresh image applies in every
case.

Fractions of the shared surface, `0` to `1`, measured against **the picture of
that surface you were last shown**. `x` and `y` are the top-left corner,
`width` and `height` the size. Give the bounds of the thing itself: the ring is
drawn around them, so a box tight on a button reads as a ring around that
button, and a box drawn where you think the ring should go puts the ring
outside that instead.

Bounds are measured off a picture that has been scaled on its way to you.
If the user has scrolled, moved a window, or changed the layout since that
frame, get a fresh view before measuring. Say what you are pointing at as
well as drawing it, so the user can check the mark against the intended
control.

Moving the share is the one kind of drift that is caught for you. A mark
measured against the surface before the move is refused rather than drawn,
because those fractions land somewhere arbitrary on the surface that replaced
it. Wait for a frame of the new one and point again.

## How to point

**One thing at a time.** A mark is where to look next. A screen with four
marks on it is not four times as helpful; it is a diagram, and nobody knows
which one to start with. Point at the current step, talk, then point at the
next one.

**Captions are imperatives, not explanations.** "Click Share", "Type the name
here", "This is the tempo". Whatever else needs saying, say out loud: the
caption is drawn over the user's own work in a window they cannot scroll or
dismiss, and it is capped at 80 characters for that reason.

**Say it as well as draw it.** The marks are a gesture that accompanies
speech, the way a person points while explaining. A mark with no words is a
riddle.

**Take them down when they stop being true.** Call `screen_clear_marks` when
the step is done, when the user has moved on, or when the conversation has
left the screen behind. Marks come down on their own if the share ends or
moves, but a mark left standing over a finished step is one the user has to
work out is stale.

## Walking someone through several steps

Sometimes the answer is one pointer. Sometimes it is a route: four places to
click, in order, before the thing they asked about happens. Decide which it is
before you draw anything, because the two are paced differently.

**Say the route before you start it.** "There are three steps. First the
Share menu, then the format, then Export." If they asked how and you inferred
they want to be walked through it rather than told, this is where they wave it
off and just want the answer. Keep it to the count and the landmarks; the
detail belongs to each step as you reach it.

**One step, then stop.** Point at it, say what to do, and then wait. The
temptation is to narrate the next step while the mark for this one is still
up, and that leaves them doing step one with instructions for step two in
their ear. Silence is the cue that it is their turn.

**Advance on evidence, not on time.** Move to the next step when a fresh
picture shows this one done, or when they tell you it is. Do not move on
because a plausible amount of time has passed.

The most direct telling is automatic. When the user clicks the control an
arrow is pointing at, a message arrives as their turn saying they clicked it,
by name, and that mark comes down on its own. Treat it as the step done: say
what comes next and point at it. Nothing arrives for a click anywhere else,
and nothing arrives for a ring, so for those the picture and their words are
still the evidence. If the next picture shows the
step not done, or done to the wrong thing, point at the same place again with
a shorter caption and say what you saw. Pointing at the next step while the
previous one is still open is how someone ends up two steps behind a mark.

**Going back is just pointing again.** There is no undo. If they went past
something, or want to see step two again, point at step two. Say which step
it is, so the words and the mark agree about where you both are.

**Close it out.** When the last step is done, clear the marks and say so, in a
word. A mark left on the final button is one the user has to work out is
stale, and a walkthrough that ends without an ending leaves them waiting for
step five of four.

## Shapes

A named control gives you an arrow. Bounds give you a ring for an extent,
a control located visually after a failed name lookup, or the circle the
user explicitly requested.
