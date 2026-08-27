# Camera mode: manual QA

What the suite cannot reach. Every check here needs a real camera, a real screen
reader, or a real OS setting, so it runs by hand.

Surface under test: the voice room with the viewfinder up (the camera paths of
`voice-room.tsx`, `camera-status-pill.tsx`, `camera-flash-control.tsx`,
`camera-shutter.tsx`, and `voice-room-control.tsx` at `surface="camera"`), plus
the deep-link capture overlay, which shares the shutter and the bottom scrim.

## iPhone

- [ ] The pill clears the notch. Open the camera in the fullscreen room on a
      notched device and on a Dynamic Island device. The pill sits below the
      island, on the minimize control's line, and never behind it.
- [ ] The pill clears the corner control. Give the assistant a name of 40
      characters or more and open the camera at portrait phone width. The name
      truncates to an ellipsis, the dot and "Photo" stay whole, and the pill's
      edge never reaches the minimize control.
- [ ] The pill clears the grabber. In the mobile sheet, the pill sits below the
      grabber and the grabber still takes the pull-down.
- [ ] Flash fires on the rear camera. Cycle off, auto, on, and take a photo in a
      dark room on each. `on` fires every time, `auto` fires when it is dark,
      `off` never fires.
- [ ] Flash is absent on the front camera. Flip to the selfie camera: the
      control disappears rather than going dead. Flip back and it returns in the
      mode it was left in.
- [ ] Flash outlives the call. Set `on`, end the session, start a new one, open
      the camera. It is still `on`.
- [ ] Flash does not leak. Set `on` in the room, close the camera, then open the
      deep-link capture overlay from a chat. Its capture does not fire.
- [ ] Backgrounding releases the preview. With the viewfinder up, background the
      app: the status bar's camera indicator goes out. Foreground it: the
      viewfinder returns, or the room reports the failure. Never a frozen frame.
- [ ] Minimizing releases the preview. Minimize with the camera up. The
      indicator goes out and the session keeps running on the composer bar.
- [ ] VoiceOver says it once. Open the camera and change state. Each change is
      spoken once, as "Photo. Listening" or "Photo. {name} speaking". Mute the
      mic mid-turn and the announcement carries "Muted". Nothing says the state
      a second time.
- [ ] VoiceOver reaches every control. Swipe through the chrome: minimize,
      flash, shutter, flip, mic, speaker, camera, end. Each name matches what a
      press does, and the flash names the state it is in rather than the act.
- [ ] VoiceOver hears a failure. Deny the camera permission in Settings, then
      press the camera control. The refusal is spoken, not only drawn.
- [ ] The capture pulse reads. Take a photo against a bright frame and a dark
      one. The crimson ring leaves the shutter and is visible on both, and
      nothing flashes the whole screen.
- [ ] Fat fingers. Hold the phone one-handed and take five photos in a row. No
      press lands on flip, on flash, or on end session.

## Android

- [ ] Flipping does not crash. Open on the rear camera, flip to front, flip
      back, five times over. `setFlashMode` is never called on a camera whose
      probe came back empty, so a flashless front camera is a control that is
      gone rather than an app that is.
- [ ] The control tracks the probe. On a device whose front camera has no flash,
      the control is present on the rear camera and absent on the front, with no
      dead state in between.
- [ ] The native preview shows through. The scrims, the pill, the shutter and
      the control row all paint over live video, and nothing behind them shows
      the app's own background.
- [ ] The scrims reach the native preview. Point at a white wall: the top and
      bottom bands darken enough to read the pill and the row, and the middle of
      the frame stays untinted.
- [ ] TalkBack says it once. Same check as VoiceOver above.

## Desktop web and macOS

- [ ] No flash, anywhere. There is no flash control in the browser or in the
      desktop app, on any camera.
- [ ] The pill is present. It renders in the panel variant and the fullscreen
      variant, top centre, on the minimize control's line.
- [ ] Reduced motion. Turn on Reduce Motion (macOS: Settings, Accessibility,
      Display), reload, open the camera. The status dot holds still and fully
      lit. The shutter's capture pulse still fires and is shorter. The core's
      morph has no overshoot.
- [ ] Keyboard walk. Tab from the top of the room: minimize, shutter, flip, mic,
      speaker, camera, end. Every focus ring is a white outline legible over the
      feed, including over a white frame.
- [ ] Escape minimizes the room from camera mode, and the camera releases.

## Design review

Deliberate departures from the handoff. Each needs a yes or a correction before
the redesign is called shipped.

- [ ] Pill vertical offset. The design puts the pill 82pt from the top. The
      build aligns it to the corner chrome's own offset, so it shares a line
      with the minimize control instead of floating on a rhythm of its own.
      Confirm the shared line, or take the 82.
- [ ] Control row bottom anchor. The design puts the row 48pt from the bottom.
      The build keeps the room's existing anchor, shared with the camera-closed
      room, so the row holds still as the viewfinder opens. Confirm the shared
      anchor, or accept the row jumping on open.
- [ ] Speaker mute colour. The design draws the assistant mute red at all times.
      The build reds it only while it is engaged, matching the mic beside it and
      keeping red for a control that is doing something to the call. Confirm.
- [ ] Morph readability. The core animates the `scale` property rather than
      `transform`, because the utilities that size it set `transform`
      themselves. Watch it both ways in Storybook (Chat/Voice/CameraShutter,
      flip the `mode` control) and confirm the overshoot reads as a record
      button starting rather than a circle being resized.
- [ ] Desktop fidelity. The chrome is shared, so the crimson accent and the pill
      apply to the desktop camera view too, minus the OS chrome and the sheet
      grabber. Confirm that is wanted on desktop.
- [ ] Minimize in camera mode. The design gives the camera view only the grabber
      and end session as exits. The build keeps the top-right minimize control,
      which is the only discoverable exit on desktop. Confirm.

## Known adjacent issues

Found by the polish audit and deliberately left alone, because none of them is
camera mode's to fix.

- The Russian catalog lags English by roughly 630 keys across `chat.json`,
  including whole namespaces. The camera surface's own copy is complete in all
  three locales; the rest is a catalog gap with no camera in it.
- The shutter uses the native `disabled` attribute while a photo uploads, so a
  keyboard press drops focus to the document body until the round trip finishes.
  The attribute is part of the shared shutter's contract and the deep-link
  overlay relies on it too.
- The ambient transcript's two `aria-live` regions render over the viewfinder
  when the captions preference is on. They carry speech rather than session
  state, so they do not contradict the pill, but nothing stands them down while
  the camera is up.
- Every control in the room wraps a `Tooltip` whose content repeats the
  accessible name, so assistive tech reads the name and then the same words as a
  description. Room-wide, and older than camera mode.
