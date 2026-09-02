# Camera mode: manual QA

What the suite cannot reach. Every check here needs a real camera, a real screen
reader, or a real OS setting, so it runs by hand.

Surface under test: the voice room with the viewfinder up, under
`src/domains/chat/voice/voice-room/` (the camera paths of `voice-room.tsx`,
`camera-status-pill.tsx`, `camera-shutter-hint.tsx`, `camera-flash-control.tsx`,
and `voice-room-control.tsx` at `surface="camera"`). Two things it runs on live
outside that directory and are in scope with it: the shutter at
`src/domains/chat/voice/camera-shutter.tsx`, which the room shares with the
deep-link capture overlay, and that overlay itself in
`src/domains/chat/components/chat-attachments/`, which also shares the bottom
scrim.

## iPhone

- [ ] The pill clears the notch. Open the camera in the fullscreen room and in
      the mobile sheet, on a notched device and on a Dynamic Island device. The
      pill sits below the island, on the minimize control's line, and never
      behind it.
- [ ] The pill clears both corner controls. Give the assistant a name of 40
      characters or more and open the camera at portrait phone width. The name
      truncates to an ellipsis, the dot and "Photo" stay whole, and the pill's
      edge never reaches the view-options button or the minimize control behind
      it.
- [ ] The pill clears the grabber. In the mobile sheet, the pill sits below the
      grabber and the grabber still takes the pull-down.
- [ ] The sheet goes full-bleed for the camera. Open the camera in the mobile
      sheet: the feed reaches the top of the screen, the rounded top corners are
      gone, and the grabber sits below the notch. Close it and the sheet drops
      back to the header's line with its corners back. With VoiceOver on,
      swiping past the sheet while the camera is up never lands on the thread
      header behind it.
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
- [ ] VoiceOver reaches every control. Swipe through the chrome: view options,
      minimize, flash, shutter, flip, mic, speaker, camera, end. Each name
      matches what a press does, and the flash names the state it is in rather
      than the act.
- [ ] View options opens as a panel, not a sheet. Tap the sliders button in the
      corner with the camera up. The panel opens anchored under the button, its
      switches take a tap, and tapping the feed outside it dismisses it. It is
      never announced as a modal dialog that traps VoiceOver, and it never
      arrives dead to touch.
- [ ] The kept-frame switch reaches the thumbnail. Enter Live, wait for the
      crimson thumbnail beside the photo strip, then turn "Kept frame" off. The
      thumbnail goes, the row it sat in goes with it when no photos are in the
      strip, and the assistant keeps answering questions about what the camera
      is pointed at. Turn it back on and the next keep draws again.
- [ ] Both switches survive a reload and a second tab. Set them, background and
      relaunch the app: they come back as set. With two web tabs open, a change
      in one is reflected in the other's panel.
- [ ] The readout row appears only where the readout does. On a staff or
      flagged session the panel has two rows; on an ordinary session it has one.
      This panel is the only place the readout is switched on and off, so check
      Settings, Debug, General carries no row for it.
- [ ] VoiceOver hears a failure. Deny the camera permission in Settings, then
      press the camera control. The refusal is spoken, not only drawn.
- [ ] The capture pulse reads. Take a photo against a bright frame and a dark
      one. The crimson ring leaves the shutter and is visible on both, and
      nothing flashes the whole screen.
- [ ] Fat fingers. Hold the phone one-handed and take five photos in a row. No
      press lands on flip, on flash, or on end session.
- [ ] iOS does not take the press. Holding never raises the text-selection
      callout, the magnifier, or a share sheet over the viewfinder.
- [ ] The native preview offers no Live. In the installed app, with the plugin
      drawing the preview, press and keep pressing the shutter. Nothing enters
      Live: the pill stays "Photo", there is no hint under the shutter, and
      letting go takes an ordinary photo, the same as a tap. VoiceOver reads no
      keyboard shortcut on the shutter.

### Live on iPhone, which is iOS Safari

Live samples the room's own `<video>` element, and the installed app usually has
none: the Capacitor plugin draws its preview behind the web view, so wherever
that preview is up Live is not offered and the shutter is the plain photo button
the checks above describe. Run this section in mobile Safari, where the
viewfinder is always the web one.

Two consequences worth knowing before filing a bug. Flash is native-only, so a
session that can run these checks has no flash control in it: the flash checks
above and these are never reachable in the same viewfinder. And in the installed
app the web preview also appears as a fallback when a native start fails, which
makes Live briefly available there; every later acquire retries the native
start, so a flip that succeeds takes the preview back, and Live ends with it
rather than the pill going on claiming a stream nothing is reading.

- [ ] The hold reads as a hold. Press and keep pressing the shutter: at half a
      second the haptic fires, the ring goes crimson, the pill says Live and the
      hint changes to "Live · Tap to stop". Letting go takes no photo, so
      nothing joins the strip and nothing new lands in the transcript.
- [ ] The hold survives a real thumb. Hold with the phone at arm's length: a
      small wobble still enters Live. Slide the thumb off the shutter, or more
      than a finger's width across it, and nothing happens: no photo either,
      including when the thumb is still on the shutter as it lifts.
- [ ] Flipping while live. Enter Live, flip the camera. The pill stays Live, the
      thumbnail clears, and a new keep appears from the new camera within a few
      seconds.
- [ ] Stopping while flipping. Enter Live, flip, and tap the shutter while the
      flip is still going. It stops: the shutter is never refused while live,
      so a slow flip cannot strand the user in it.
- [ ] Backgrounding while live. Background the app with Live running. The camera
      indicator goes out. Foreground it: the viewfinder returns on photo, not
      streaming, and nothing was sent while the app was away.
- [ ] VoiceOver says the mode. With Live running, VoiceOver reads "Live.
      Listening" on the next state change, and the shutter is named "Stop live".
      Back on photo it reads "Photo. Listening" and "Take a photo".

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
- [ ] Keyboard walk. Tab from the top of the room: view options, minimize,
      shutter, flip, mic, speaker, camera, end. Every focus ring is a white
      outline legible over the feed, including over a white frame.
- [ ] Escape closes the panel before it minimizes the room. With the view
      options open, one Escape closes the panel and leaves the room up; a second
      minimizes the room.
- [ ] A mouse can hold. Press and keep the button down on the shutter for half a
      second: Live starts, and releasing takes no photo. Press and drag off the
      button before the half second and nothing happens at all.
- [ ] Space holds. Focus the shutter and hold Space: Live starts, and the
      release takes no photo. Tap Space and one photo is taken, the same as a
      click. The page never scrolls under either.
- [ ] Leaving and re-entering Live quickly shows nothing for a few seconds. Stop
      Live and start it again: the first keep can take up to five seconds. That
      is the gate's rate floor, which survives the reset by design; it is not a
      stall.
- [ ] Escape minimizes the room from camera mode, and the camera releases.
- [ ] Locale sweep. Switch the app to Spanish and then to Russian, open the
      camera, and deny the permission in the browser. The pill, every control
      name, and the failure message all read in that language. No key names
      (`cameraError.permissionDenied` and the like) reach the screen, and no
      English is left over.

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
- [ ] Pill centring with two corner controls. The design centres the pill on the
      screen against a single corner control. The build centres it in the band
      the corner cluster leaves, so it sits a little left of screen centre: with
      two 52px controls there, a screen-centred pill reaches under them at phone
      width before its own floor width is spent. Confirm the band centring, or
      ask for a pill that may narrow past its floor instead.
- [ ] View options as a panel on touch. The chat column's other panels open as a
      bottom sheet on a phone. This one stays anchored on every form factor: the
      room is itself a sheet whose flush camera state inerts the overlay host it
      shares, so a nested sheet arrives inert. Confirm the anchored panel on a
      phone, or ask for the sheet and the room's inerting reworked with it.
- [ ] Capture feedback reaches the deep-link overlay too. The shutter is shared,
      so dimming the core while a frame uploads restyles the overlay's shutter
      as well as the room's, and it is an opacity dip rather than the core
      shrinking. Take a photo from the overlay and confirm the dip reads as
      "working" there, or ask for a treatment that is the room's alone.
- [ ] Flash glyph and blur. The bolt is bespoke (lucide has no slashed one and
      none that carries a badge) and snapped to lucide in three ways: the
      24-unit viewBox, the 2-unit stroke, and the 20px it renders at. Its
      resting state also carries `backdrop-blur-sm`, which the handoff draws as
      a flat fill. Confirm the glyph sits as a sibling of the icons beside it,
      and that the blur is wanted over a busy frame.
- [ ] Auto badge offset. The handoff pins the "A" at right 6 / bottom 5, which
      reads as detached from the 20px bolt (design feedback, 2026-08-28). It
      sits at right 12 / bottom 10, tucked against the bolt's lower tip so the
      pair reads as one glyph. Confirm with design or take the spec offsets
      back.
- [ ] Localized session words on the surfaces outside the room. The composer's
      voice bar, the title-bar session pill, the iOS Dynamic Island and the
      macOS companion panel all read the session's state through the catalog,
      so they follow the app language the way the room does. Sweep them in
      Spanish and Russian alongside the room, the island backgrounded so a
      server-composed push is what lands.

## Known adjacent issues

Found by the polish audit and deliberately left alone, because none of them is
camera mode's to fix.

- The Russian catalog lags English by roughly 630 keys across `chat.json`,
  including whole namespaces. The camera surface's own copy is complete in all
  three locales, failure messages included (`cameraError.*`, `cameraDeepLink.*`,
  `cameraStatusPill.*`, `liveVoiceStatus.*`, `voiceRoom.*`); the rest is a
  catalog gap with no camera in it.
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
