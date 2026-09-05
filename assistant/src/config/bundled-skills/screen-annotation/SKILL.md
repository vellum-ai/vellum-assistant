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
      - "User asks where something is, or how to do something, in an app they are sharing on a call"
      - "User wants to be shown how rather than have it done for them"
      - "The answer to a question is a place on the user's screen"
    avoid-when:
      - "User wants the assistant to do the thing rather than be shown it (use computer-use)"
      - "Nothing is being shared, so there is no surface to point at"
---

Drawing on the screen the user is showing you, so they can go and do the
thing themselves.

This is the opposite errand from computer use. Nothing here clicks, types or
drives anything: the marks are a way of pointing while you talk, for someone
who wants to learn where a control is rather than have it operated for them.
The ring is drawn outside the bounds you give and never takes the mouse, so
what you point at stays visible and clickable the whole time.

## Requires a screen share

Marks are drawn on the frame around the surface the user is sharing with the
call. With nothing shared there is nowhere to draw, and `screen_point_at`
fails saying so. Ask them to share their screen from the call, then point.

## Coordinates

Fractions of the shared surface, `0` to `1`, measured against **the picture of
that surface you were last shown**. `x` and `y` are the top-left corner,
`width` and `height` the size.

Give the bounds of the thing itself. The ring is drawn around them, so a box
tight on a button reads as a ring around that button; a box drawn where you
think the ring should go puts the ring outside that instead.

Your picture is only as fresh as the last frame you were sent. If the user has
scrolled or moved a window since, say what you are pointing at as well as
drawing it, so a mark that has drifted is still recoverable in words.

## How to point

**One thing at a time.** A mark is where to look next. A screen with four
rings on it is not four times as helpful; it is a diagram, and nobody knows
which one to start with. Point at the current step, talk, then point at the
next one.

**Captions are imperatives, not explanations.** "Click Share", "Type the name
here", "This is the tempo". Whatever else needs saying, say out loud: the
caption is drawn over the user's own work in a window they cannot scroll or
dismiss, and it is capped at 80 characters for that reason.

**Say it as well as draw it.** The marks are a gesture that accompanies
speech, the way a person points while explaining. A ring with no words is a
riddle.

**Take them down when they stop being true.** Call `screen_clear_marks` when
the step is done, when the user has moved on, or when the conversation has
left the screen behind. Marks come down on their own if the share ends or
moves, but a ring left standing over a finished step is one the user has to
work out is stale.

## Shapes

Today a mark is a rectangle, drawn as a ring around whatever it encloses. To
point at something that is not rectangular, give the bounds of the area it
sits in rather than trying to trace it: a ring around a slider's track, or
around the corner of a canvas where a handle lives.
