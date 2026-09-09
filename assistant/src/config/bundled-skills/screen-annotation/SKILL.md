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
      - "User asks where something is, how to do it, or to be walked through it, in an app they share on a call"
      - "User wants to be shown, not have it done for them"
      - "The answer is a place on the user's screen"
    avoid-when:
      - "User wants the assistant to do the thing rather than be shown it (use computer-use)"
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

**Name the thing.** `{"target": "color balance", "caption": "Click this"}`.
The name is looked up on the surface itself, which knows where its controls
actually are, and an arrow is drawn at it.

**The label, not a description of it.** What is matched is the control's own
name. Casing, spacing and punctuation are forgiven, so `Color Balance` finds
`color balance`; nothing beyond that is, so "the stabilization button" finds
nothing, because no control is called that. Give the label on its own:
`stabilization`, `Send`, `Search`.

The arrow points at the middle of the control and stops just short, so what
you are sending someone to stays visible the whole time.

You are answered with what was drawn and the name it resolved to, which is not
always the name you asked for. Say the resolved one out loud: it is the word
the user can see.

A name the surface does not carry draws nothing and comes back with the names
it does carry. That is the answer, not a setback: the thing is nearly always
one of those, so read the list and point again. **Never fall back to
coordinates for a control you could not find.** A mark drawn at a guess is
worse than no mark, because someone follows it; the words you say are the
better tool for a thing you cannot point at. What the user calls something and
what the surface calls it often differ, which is what the list is for: they
may say "white balance" where the control reads `color balance`, or "the
stabilization button" where it reads `stabilization`.

## Coordinates, for an extent

For when the size of the thing is the message rather than where it is: a
region of an image, an area of a canvas, a panel spoken of as a whole. These
draw a ring around the bounds instead of an arrow at a place.

Fractions of the shared surface, `0` to `1`, measured against **the picture of
that surface you were last shown**. `x` and `y` are the top-left corner,
`width` and `height` the size. Give the bounds of the thing itself: the ring is
drawn around them, so a box tight on a button reads as a ring around that
button, and a box drawn where you think the ring should go puts the ring
outside that instead.

These are a guess measured off a picture that has been scaled on its way to
you, and they are only as fresh as the last frame you were sent. If the user
has scrolled or moved a window since, say what you are pointing at as well as
drawing it, so a mark that has drifted is still recoverable in words.

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
because a plausible amount of time has passed. If the next picture shows the
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

A mark is either an arrow at a place or a ring around an extent, and naming a
control gives you the arrow. Reach for the ring only when the extent is the
thing being said: "this whole panel", "this part of the picture". A ring
around one button says something about where that button ends, which is
rarely what you mean and is the part most likely to be wrong.
