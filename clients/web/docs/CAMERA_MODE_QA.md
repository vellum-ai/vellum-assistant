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
- [ ] The pill sits dead centre on the screen. Open the camera at portrait
      phone width and again in landscape, in Photo and in Live, on a device
      whose side insets are uneven (a notched phone held sideways, where the
      cutout is on one side only). The pill's centre is the SCREEN's centre in
      all four, whether or not the view-options button is drawn in the left
      corner, and it does not shift sideways as Live starts or stops. The gap
      from the pill to each corner control is allowed to differ on that device:
      the controls hug their own side's inset, the pill answers to the screen.
- [ ] The pill clears both corner controls. Give the assistant a name of 40
      characters or more and open the camera at 320pt width with the longest
      state string the locale has. The name truncates to an ellipsis, the dot
      and "Photo" stay whole, the pill holds one line, and its edge never
      reaches the view-options button or the minimize control behind it.
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
- [ ] Flash is one circle with the rest. With the rear camera up, the flash is
      the same size as flip, the two mutes, the camera toggle, end session and
      the two corner controls, in Photo and in Live and in all three states,
      with the auto badge still on the bolt at the larger circle.
- [ ] Flash and flip are mirrored, on the corner controls' column. They sit the
      same distance in from their own edges, on one line with the shutter's
      centre, and in portrait that distance is the room's corner gap: flash
      lines up under the view-options button and flip under the minimize
      control. Rotate to landscape on a notched phone and both move in together
      to the deeper of the two side safe-area insets.
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
      TOP-LEFT corner with the camera up. The panel opens under the button and
      aligned to its left edge, entirely on screen in portrait and in landscape
      with a side inset, its switches take a tap, and tapping the feed outside
      it dismisses it without taking a photo. It is never announced as a modal
      dialog that traps VoiceOver, and it never arrives dead to touch.
- [ ] The kept-frame switch reaches the thumbnail. On a fresh profile the
      switch is off and Live draws no thumbnail: enter Live, sit through
      several keeps, and only the photo strip is in the row. Turn "Latest
      shared frame" on and the next keep draws beside the strip. Turn it off
      again and the thumbnail goes, the row it sat in goes with it when no
      photos are in the strip, and the assistant keeps answering questions
      about what the camera is pointed at.
- [ ] A device that used voice before converges too. On a profile that already
      has a `vellum:voice-prefs` payload, the switch is off on the first launch
      after this change whatever that payload said, and the thumbnail does not
      draw until the panel turns it on. Turn it on and relaunch: it stays on.
      A value written from here is the first one that is a choice, since every
      earlier payload carries either nothing for the field or the default of
      the day that a setter captured wholesale.
- [ ] Both switches survive a reload and a second tab. Set them, background and
      relaunch the app: they come back as set. With two web tabs open, a change
      in one is reflected in the other's panel.
- [ ] An older build does not eat a newer one's preferences. Only checkable
      around a rollback or with two builds side by side. Let the newer build
      write `vellum:voice-prefs`, then open the older one: it reads the
      preferences it understands and shows them, and the key on disk is
      untouched, still carrying the newer build's stamp and any field the older
      one has no name for. Changing a preference in the older build moves it on
      screen for that session and still does not write. Roll forward and
      everything the newer build stored is intact.
- [ ] The readout row appears only where the readout does. On a staff or
      flagged session the panel has two rows; on an ordinary session it has one.
      This panel is the only place the readout is switched on and off, so check
      Settings, Debug, General carries no row for it.
- [ ] The readout is a strip on a phone. On a staff or flagged session, switch
      the frame gate readout on with the camera up. What appears under the
      chrome band is one slim glass row: the verdict and three small meters,
      never the full card. It clears the whole band above it: the view-options
      button it sits directly under, the status pill, and the minimize, with a
      long assistant name in the pill.
- [ ] The strip opens the readout, and gives the frame back. Tap the strip: a
      sheet rises from the bottom with the decision order, the recent frames,
      the keeps and the threshold sliders. Tap the frame anywhere outside it,
      and separately tap the bar at the top of the sheet: each closes it, and
      neither press reaches the shutter underneath. The strip stays up while
      the sheet is open and its meters keep moving.
- [ ] The sheet scrolls, and the room holds still under it. The readout is
      taller than the sheet's height cap, so the lower sliders are reachable
      only by scrolling. With the sheet open, swipe up and down its body: the
      readout scrolls to the reset button and back, and the room never starts
      sliding toward a minimize. Drag a threshold sideways across its whole
      range and the same holds.
- [ ] The open sheet stands the room's pull-down down, and closing gives it
      back. With the sheet open, drag downward on the frame outside it: nothing
      moves, because a press out there is aimed at dismissing the readout and
      answering it with a minimize would hang the call off a tap that missed.
      Tap once to close, then drag downward from the same place, and from the
      strip: the room minimizes both times.
- [ ] The room's own pull-down is unchanged everywhere else. With no readout on
      screen at all, drag the room down from its chrome, from the middle of the
      feed, and from over a control: it tracks the finger, springs back from a
      short pull and minimizes past the threshold, exactly as on main. Sliding
      a finger sideways across the control row still does not start it.
- [ ] Holding still raises no callout. Press and hold on the room for a couple
      of seconds: no text is selected and iOS shows no selection callout or
      magnifier.
- [ ] Tuning survives the collapse. Move a threshold in the sheet, close it,
      and open it again: the value is where it was left, and the dot marking a
      moved threshold is still beside it. Reset puts every slider back.
- [ ] VoiceOver hears a failure. Deny the camera permission in Settings, then
      press the camera control. The refusal is spoken, not only drawn.
- [ ] The capture pulse reads. Take a photo against a bright frame and a dark
      one. The accent ring leaves the shutter and is visible on both, and
      nothing flashes the whole screen.
- [ ] The camera wears the assistant's colour. Call an assistant that has an
      avatar accent and open the camera: the Live pill's fill, the shutter ring
      while Live runs, the "Live · Tap to stop" hint, the pill's dot while the
      assistant talks, and the kept-frame ring are all that accent. Call an
      assistant with no accent (an uploaded image the daemon read no colour
      from) and the same chrome is the camera's crimson. The Live pill wears a
      hair-darker crimson than the ring beside it there, which is that fill
      held to the same text floor every accent is held to.
- [ ] A colourless call keeps its own colours while the app moves on. Start a
      call with an assistant that has no accent, then switch the app to an
      assistant that does while the call runs. The call's room stays crimson
      and its waves stay indigo: neither picks up the newly selected
      assistant's colour. This is the one to watch after any change to how the
      room publishes its accent, since the failure is silent and looks like a
      theme rather than a bug.
- [ ] A pale accent and a dark one both read. Repeat the row above with the
      lightest accent the palette offers (yellow) and a dark one. The Live
      pill's label flips with the fill: near-black on the yellow, white on the
      dark accent, and the whole pill including the separator and the assistant
      name follows it. The dot while the assistant talks flips with it, dark on
      the yellow and pale on the dark accent, so it always reads against the
      fill it sits on. A mid-grey accent from an uploaded image is the case
      worth a third look: no black-or-white ink clears the small-text floor on
      those, so the pill fills with the accent nudged to the near edge of that
      band instead. Expect the pill to read very slightly darker or lighter
      than the ring beside it there, by a step most eyes cannot find without
      the two side by side; anything bigger than a nudge is a bug. The accent
      itself is never nudged, so the hint and the
      shutter ring over the feed are whatever colour the assistant is; if one of
      those fails it fails on the waves and the shimmer too, and the fix belongs
      in the avatar accent system rather than in the camera.
- [ ] The Live pill's second word is not dimmed. On the filled pill the
      session's word, or the assistant's name in its place, is the same
      strength as "Live" in front of it; on the glass Photo pill it sits back a
      step. The filled pill has no strength to give away: it wears the accent
      adjusted to land on the text floor exactly, so a word drawn at 80% there
      composites back under it. The faint separator between the two stays faint
      in both, since it is a mark rather than a word.
- [ ] The Live pill is opaque and the same colour on every frame. Point the
      camera at something black and then at something white with Live running.
      The pill does not change shade with the frame behind it, which is what
      makes its label's contrast a property of the fill rather than of the
      view. True on every engine, including the iOS 15 row below. The glass
      Photo pill beside it does still let the frame through, and is the one
      place that is wanted.
- [ ] The idle and user dots on a pale fill. Those two stay white in every
      mode, so on the yellow fill they are pale marks on a pale fill (about
      1.6:1 for the user's, lower for the half-lit idle one). Note whether they
      read. They are 6px state marks rather than text, and inking them would
      cost the colour jump that tells the user's dot from the assistant's, so
      this is a design call rather than a contrast bug.
- [ ] iOS 15 keeps the whole pink pill. On a device or simulator older than
      16.2, where `color-mix()` does not exist, the Live pill draws all three
      of the crimson fill, white text, and the rose dot, whatever accent the
      assistant has. It is the same clamped crimson the newer engines fall back
      to and it is equally opaque, so the label reads 4.56 there as well. The
      failure to look for is a split set: near-black text on the crimson fill,
      or a dot mixed for an accent the pill is not wearing. Either means
      something escaped the feature query the three share.
- [ ] iOS 15's one visible difference. On those engines the shutter ring, the
      Live hint and the thumb ring still follow the assistant's accent, since
      each is one property with nothing to keep in step, while the capture
      pulse and the kept-frame ring stay crimson. A teal ring emitting a pink
      pulse is that mismatch and is expected: the alternative is spending the
      accent everywhere on those engines to fix one 500ms animation.
- [ ] Fat fingers. Hold the phone one-handed and take five photos in a row. No
      press lands on flip, on flash, or on end session.
- [ ] iOS does not take the press. Holding never raises the text-selection
      callout, the magnifier, or a share sheet over the viewfinder.
- [ ] The native preview offers Live. In the installed app, with the plugin
      drawing the preview, press and keep pressing the shutter. At half a second
      the pill says Live and the hint changes to "Live · Tap to stop", the same
      as in the browser, and letting go takes no photo. Tap to stop and the
      shutter takes ordinary photos again.
- [ ] Keeps pulse behind the native preview. With Live running, hold the phone
      steady on a subject. Within a few seconds the accented held-frame
      thumbnail appears beside the photo strip and a frame lands in the
      transcript; move to a new subject and another follows. Nothing ever
      pulsing is the slow-bridge case in the section below, not a hang.

### Live on native mobile

Live runs behind either viewfinder. In mobile browsers it samples the room's own
`<video>`; in the installed app, where the Capacitor plugin draws its preview
behind the web view and there is no element to read, it polls the plugin for a
sample instead. Run this section in both: they are two different samplers
feeding one gate, and only the installed app exercises the bridge.

The native path takes a PAIR of samples about 60ms apart on every poll. The
first is only a motion baseline and is never kept; the second is the one judged
and, on a keep, the exact frame uploaded. That is what lets the gate tell a
steady camera from a moving one, which on a handheld phone is also the blur
check. Android shells with paired capture collect both preview buffers before
encoding and return their native timing in one bridge call. iOS and older Android
shells take two bridge round trips and bound the gap from request/answer times.

- [ ] **Android native pair timing.** Install the APK with paired capture and
      load the matching web UI. Hold a detailed subject steady in Live, then pan
      and settle on a different subject. Feedback should show `decisions` and
      `keeps` increasing, with pair gaps at or below 120 ms even when capture
      duration is several hundred milliseconds. `captureRequests` counts bridge
      calls, so paired capture normally has one request per attempt. Genuinely
      distant pairs must still increment `pairGapRejections`.
- [ ] **Native lifecycle and compatibility.** During Live, flip the camera,
      background and resume the app, and close/reopen the camera. Frames from
      the retired camera must not appear afterward. Ask a question while a pair
      is being encoded and verify that a fresh pair answers it. A normal shutter
      photo must still work. Repeat on iOS and an older Android shell to verify
      the single-sample bridge contract still works.

- [ ] **Slow-bridge signature, if Live keeps nothing.** A pair whose two
      captures land further apart than the gate's motion window is discarded
      rather than offered, because a frame with no motion reading is keepable
      while the camera is still moving. On a device that never manages the
      window this looks like a Live session that runs and never pulses: pill on,
      no held-frame thumbnail, nothing new in the transcript, and a tuning
      readout whose decision count sits still while the camera is plainly open.
      That is the expected refusal, not a hang. Each discarded pair logs
      `[native-frame-source] pair outside the motion window, skipped:` with the
      gap it measured and the limit; capture that number and the installed APK
      version in the report. On paired Android capture this gap measures native
      preview delivery, independent of JPEG encoding and bridge latency.
- [ ] **Sampling diagnostics in feedback.** Reproduce with Live enabled for at
      least 30 seconds, close the camera, and export feedback in the same app
      session. `web-chat-diagnostics.json` includes `native_camera_sampling`
      lifecycle events on iOS and Android, even with the frame gate readout off.
      These carry capture durations, measured pair gaps and the gap limit, plus
      counts of empty captures, timeouts, decode failures, sample errors,
      rejected pairs, decisions and keeps. Rising `pairGapRejections` with zero
      `decisions` identifies rejection before the gate; rising `keeps` without
      delivered frames points downstream. During transport reconnects,
      `suppressedCaptures` counts captures skipped before reaching the bridge;
      these do not increment `captureRequests` or `emptyCaptures`. Totals are
      emitted on start, after the first attempt, at most once every 30 seconds
      while sampling, and on stop. Images and raw bridge errors are not included.
- [ ] **Battery and thermals over a ten-minute call.** Hold Live for a sustained
      stretch and note case temperature and battery drain against the same call
      without Live. Two captures a second is the cost being measured, plus at
      most one extra pair per question: the start of an utterance asks the poll
      for a sample out of cycle instead of waiting for its next tick.

### The frame the question is about

Speech start is the client's only signal for "the answer is about what the
camera is pointed at right now". It arms the gate for one keep, which skips the
rate floor and the novelty bar but not the warmup or the detail floor, and on
the native path it also asks the poll for a pair at once. Run these in both
hands-free and push-to-talk, on iOS, Android and desktop web.

- [ ] **Point at A, ask, then point at B and ask.** With Live running, ask about
      one object, let the answer finish, move the camera to a different object
      and ask "what am I looking at now?". The answer describes the second
      object, not the first. Five times over, in both session modes and on each
      platform. An answer about the previous object is the bug this exists to
      catch; note which mode and platform it happened in.
- [ ] **Short-question stress.** Pan to something new and immediately ask a
      question about a second long ("what is this?"). Note any answer that
      describes the previous scene, and the network the device was on. The keep
      races the upload here, and how often it loses is what decides whether the
      daemon-side hold needs the earlier client hint on top of it.
- [ ] **One frame per question, not a burst.** With the tuning readout on, watch
      the decision order as a question starts: exactly one keep is decided as
      "Asked for", and the frames right behind it are turned away by the rate
      floor rather than keeping again. A pair of near-identical frames in the
      transcript per question is the regression.
- [ ] **Nothing is kept when nothing is being asked.** Hold Live and stay quiet
      for a minute: keeps come at the ambient cadence only. Then mute the mic
      and speak: no keep follows the speech.

- [ ] The hold reads as a hold. Press and keep pressing the shutter: at half a
      second the haptic fires, the ring takes the accent, the pill says Live
      and the hint changes to "Live · Tap to stop". Letting go takes no photo,
      so nothing joins the strip and nothing new lands in the transcript.
- [ ] Every keep is felt. With Live running on a subject the gate keeps from,
      one light tap lands with each accented thumbnail and no others: a scene
      the gate skips is silent, and so is a keep that never reaches the call.
      Turn the phone to airplane mode mid-Live and hold it on a new subject:
      through the reconnect gap nothing taps, because nothing was shared. The
      tap is what the feature has instead of a screen the user is looking at,
      since Live is aimed at the thing being talked about.
- [ ] The tap is not the shutter's. Take ordinary photos: no haptic fires on a
      tap, only on the hold that enters Live and on the keeps that follow.
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

## Small screens and rotation

Both shells. Live reaches a phone through the native frame source, so the kept
frame and the photo strip share a floor at widths no desktop imposes on them,
and every check here is about what that floor does as it runs out of room.

Handsets, not simulators: the iOS Simulator provides no camera feed, so it
answers nothing here.

- [ ] The capture row fits the narrowest phone. On a 320pt-wide device, take
      three photos and then hold for Live: the three receipts and the accented
      kept frame sit in one row above the shutter. Nothing is clipped at the
      right edge, nothing scrolls or wraps, and the row is on its own line
      rather than reaching the shutter or the flip control. Storybook's
      Chat/Voice/CameraModeScreen, story "NarrowPhoneCaptureRow", is the same
      composition at the same width to check it against.
- [ ] The row clears the sensor housing in landscape. Rotate to landscape with
      photos on the floor: the first thumbnail starts inboard of the notch on
      the notched side, on the same left edge the tuning readout uses.
- [ ] The landscape floor still reads. Rotate with the camera up. The bottom
      scrim's 15rem floor is most of a short viewport, so check that the
      shutter, the hint, the capture row and the session row are all on screen
      and legible over a bright frame, and that the scrim does not reach the
      status pill at the top.
- [ ] Rotating with Live running. Enter Live, rotate the device, rotate back.
      Android recreates the camera fragment on rotation, and no automated test
      covers a rotation with sampling active, so watch for all of: the pill
      stays Live or drops cleanly back to photo (never Live over a dead poll),
      the tuning readout's decision rate is unchanged rather than doubled, no
      keep from before the rotation lands in the transcript after one from
      after it, and the viewfinder is live video rather than a frozen frame.

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
- [ ] Live behind the native preview. Android runs the same poll as iOS, so run
      the "Live on iPhone" section here too: the hold enters Live, keeps pulse
      and land in the transcript, and a device that keeps nothing shows the
      slow-bridge signature rather than hanging.
- [ ] Haptics on Android. The light impact is the only effect this shell fires,
      so it is the whole surface to check. Hold the shutter: a tap at half a
      second, then one per keep, the same as iPhone. Then the gesture that has
      an effect at each end: pull the transcript to refresh and feel exactly one
      tap, as it crosses the threshold. Its completion is a heavier impact or a
      notification, neither of which Android fires, so a second tap there is the
      regression to watch for.
- [ ] TalkBack says it once. Same check as VoiceOver above.

## Desktop web and macOS

- [ ] No flash, anywhere. There is no flash control in the browser or in the
      desktop app, on any camera.
- [ ] The pill is present. It renders in the panel variant and the fullscreen
      variant, top centre, on the minimize control's line.
- [ ] The panel's edges are clean. Once the feed is up, zoom into all four
      corners of the desktop panel at the pixel level (and along the straight
      edges on a non-Retina display): no avatar-tone pixels and no dark
      hairline on any of them.
- [ ] The look stands behind the feed until it has a frame. Open the camera and
      watch the moment it comes up: the look is what shows through the
      viewfinder until the first frame lands, never the chat behind the panel.
      Flip the camera and the look returns for the swap rather than going
      black.
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
- [ ] The readout is a card here, and it changes width with the window. On a
      staff or flagged session with the readout on, the full card is parked
      under the chrome band with every slider on it. Narrow the browser window
      past the mobile breakpoint: the card is replaced by the strip. Widen it
      again and the card comes back, with the thresholds where they were left.
- [ ] A mouse can hold. Press and keep the button down on the shutter for half a
      second: Live starts, and releasing takes no photo. Press and drag off the
      button before the half second and nothing happens at all.
- [ ] Space holds. Focus the shutter and hold Space: Live starts, and the
      release takes no photo. Tap Space and one photo is taken, the same as a
      click. The page never scrolls under either.
- [ ] Leaving and re-entering Live quickly shows nothing for a few seconds. Stop
      Live and start it again: the first keep can take up to three seconds. That
      is the gate's rate floor, which survives the reset by design; it is not a
      stall.
- [ ] Escape minimizes the room from camera mode, and the camera releases.
- [ ] Locale sweep. Switch the app to Spanish and then to Russian, open the
      camera, and deny the permission in the browser. The pill, every control
      name, and the failure message all read in that language. No key names
      (`cameraError.permissionDenied` and the like) reach the screen, and no
      English is left over.

## First-open explainer

The "Photo or Live?" sheet, shown once per device the first time the viewfinder
comes up on a session where Live is on offer. Run it on a phone and on desktop:
the two presentations are a bottom sheet and a centred modal, and only the phone
exercises the native preview underneath.

A device that has already seen it will not show it again, so reset between runs
by clearing the app's site data, or by deleting `cameraExplainerSeen` from
`vellum:voice-prefs` in local storage.

- [ ] It comes up after the preview, not before it. Open the camera: the
      viewfinder is already drawing frames when the sheet arrives. Nothing
      explains the camera before the camera control is pressed, which is what
      keeps the OS permission prompt the first thing the user is asked.
- [ ] The camera is still in Photo behind it. The shutter under the sheet is the
      photo shutter, and dismissing it leaves the viewfinder exactly where it
      was.
- [ ] It is over the native preview, not under it. On the installed iPhone app
      and on Android, the sheet, its scrim and both illustrations paint over live
      video. A sheet that is invisible, or one that shows the app background
      instead of the feed, is the failure this row exists for: no automated test
      can see it.
- [ ] "Got it" is remembered. Dismiss with the primary button, close the camera,
      open it again: nothing. Restart the app and open the camera: still
      nothing.
- [ ] A scrim tap is remembered. Same check, dismissing by pressing outside the
      sheet.
- [ ] Escape is remembered, on desktop. The key closes the sheet and leaves the
      room up; a second press minimizes the room.
- [ ] The close glyph is remembered, on desktop. Same check with the modal's own
      ✕.
- [ ] "Try Live now" enters Live. The pill reads Live, the shutter says "Stop
      live", and keeps begin to land. It is the only way out that changes the
      mode.
- [ ] "Try Live now" is absent once Live is already running. Ask the assistant
      to look at something so the spoken ask arms Live, on a device that has not
      seen the sheet: the sheet still comes up, with the primary button alone.
- [ ] A press inside the sheet does not minimize the room. Press and swipe down
      on the sheet's body, its buttons and its cards on a phone: the room stays
      up. The room still minimizes from a pull anywhere outside the sheet.
- [ ] The desktop modal is centred in the content pane, and its scrim dims that
      pane only: the left sidebar and the title bar stay undimmed. Undimmed is
      not the same as usable. The modal is a focus trap by design, so while it
      is up Tab cycles inside it, focus never reaches the sidebar, and Escape
      or any other dismissal is the way out. Dismissing hands focus back to the
      room.
- [ ] A short window still fits. Narrow the desktop window past a phone's width,
      and turn a phone to landscape: the modal is what shows on a fine pointer,
      its body scrolls rather than clipping, its footer wraps the privacy line
      above the buttons, and the close glyph stays in the corner.
- [ ] Reduced motion. With Reduce Motion on, the phone's sheet fades in rather
      than sliding up. The desktop modal has no entrance to swap: it is drawn
      in place either way, so check only that it still appears.
- [ ] Locale sweep. In Spanish and Russian the title, both cards, the privacy
      line and both buttons read in that language, with the assistant's name
      interpolated and no key names on screen.

### Re-showing it from the view options

The way back to the sheet once the device has seen it. Run these after one of
the dismissals above, on both presentations.

- [ ] The row is there. Open the camera's view options from the top-left corner:
      under the switches sits "How Photo and Live work", white on the same
      glass, with a chevron closing the row.
- [ ] Pressing it swaps one surface for the other. The panel goes and the sheet
      or modal arrives in its place, over the running preview, with the camera
      still in Photo behind it. Nothing of the panel is left under the scrim.
- [ ] Every way out behaves as it does on the first open. "Got it", a scrim
      press, Escape and the desktop close glyph all leave Photo; "Try Live now"
      enters Live. The row is still there on the next open of the panel.
- [ ] Keyboard: focus comes back. Reach the row by Tab and activate it with
      Enter, then dismiss the explainer: focus lands on the view options button,
      not at the top of the page. happy-dom reports the body for this either
      way, so no automated test covers it.

### Deliberate departures from the handoff

Each needs a yes or a correction.

- [ ] The seen flag is per device rather than per account, stored beside the
      other voice preferences. A second device shows the sheet again.
- [ ] There is no consent sheet before Live. The explainer is the education and
      the press is the consent, which is what the shutter's hold already
      assumes.
- [ ] The privacy line says what this product does: everything the assistant
      sees stays in the assistant's own private workspace, and Live ends when
      the camera closes. The handoff's "Photos and video aren't saved" is not
      true here, since photos and kept frames are persisted messages.
- [ ] The faces are the app's, the serif brand face and the type scale, rather
      than the handoff's Playfair Display and Manrope.
- [ ] The two illustrations are drawn once in the phone's numbers and scaled to
      whichever box they land in, so the desktop pair is the phone pair
      enlarged.

## Grouped frame transcript

Run on desktop web, macOS, mobile Safari, and the installed iPhone app in Live.
Use a development build with `vision-mode` enabled.

- [ ] Let five keeps land without speaking. One standalone bubble grows on its
      first frame, with every tile visible. Say "What is this?": the words and
      all five tiles share one user bubble and the sentinel text stays hidden.
- [ ] Open a frame preview before speaking. Speech rehosts the grid and closes
      the preview. This is accepted; every tile and its message anchor remains.
- [ ] Read the saved-time labels, including seconds, on mouse hover and touch.
      These are row saved times, not evidence of when the model consumed a frame.
- [ ] Throttle the connection so pending and hydrated frames appear together.
      Hydration preserves tile height. The preview gallery includes only hydrated
      frames in chronological order, and each download matches its selected tile.
      Keep a later preview open while earlier frames hydrate or history prepends.
      The selected frame, counter, and next/previous navigation stay consistent,
      including legacy frames that share an attachment id.
- [ ] Follow links to frame 6 and the final loaded frame. Both scroll to the
      corresponding tile without expanding a group. Reload and repeat.
- [ ] Page older history above a group, then into a standalone group. Preserve
      the viewport even when the entire loaded page is one run and its first
      host changes. Repeat while a new ambient keep arrives. A genuine spoken
      or typed message arriving during pagination must still pin its new turn.
      In a tall, underfilled viewport, pages containing only frames for an
      existing utterance must continue loading until the viewport fills or
      history ends. Hydration alone must not restart a stopped load chain.
- [ ] Take a shutter photo after ambient keeps. The photo adopts the preceding
      run and keeps its own attachment. Plain text reading `(camera frame)` and
      speech carrying a parked frame retain ordinary user-message behavior.
- [ ] Insert visible deleted messages, reactions (including Slack), status
      cards, deliberate-silence rows, and assistant replies between runs. Every
      preceding frame remains visible. Hidden notifications and queued messages
      neither appear nor split a run.
- [ ] Exercise roughly 120 frames at desktop and narrow phone widths. All tiles
      render, wrap without horizontal overflow, and the final tile opens promptly.
- [ ] Inspect the following utterance's model context: each keep remains a
      separate persisted row. Ordinary messages, retention, and turn timing retain
      their behavior.

Synthetic Storybook observations (2026-09-14): the 120-frame story rendered 120
DOM tiles at desktop and 390px viewport widths. At the narrow width, the grid's
379px client width equaled its scroll width, with no horizontal overflow. The
final tile opened slide 120 of 120 at both sizes and interactions responded
promptly. Mixed pending and hydrated tiles each measured 78px high and showed
distinct saved times including seconds. These observations used synthetic story
data. Physical iPhone behavior, a live camera session, and actual model-context
inspection remain unverified.

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
- [ ] Desktop fidelity. The chrome is shared, so the capture accent and the pill
      apply to the desktop camera view too, minus the OS chrome and the sheet
      grabber. Confirm that is wanted on desktop.
- [ ] Minimize in camera mode. The design gives the camera view only the grabber
      and end session as exits. The build keeps the top-right minimize control,
      which is the only discoverable exit on desktop. Confirm.
- [ ] Pill centring against one control per corner. The build takes one
      reserve off both edges of the band, the deepest of the corner offset and
      the two safe-area insets plus a 52px control and its gap, so the pill's
      centre is the screen's centre and a long name still has a ceiling to
      truncate inside at 320pt. On a device with uneven side insets that leaves
      the shallow side more clearance than it needs. Confirm the screen-centred
      pill, or ask for one centred between the controls instead.
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
      sits 10 right of and 12 below the circle's centre, tucked against the
      bolt's lower tip so the pair reads as one glyph. Confirm with design or
      take the spec offsets back.
- [ ] Flash circle and flank offsets. The design draws the flash at 46pt, 44pt
      in from the left, against a 52pt flip 30pt in from the right. The build
      draws both flanks at the room's 52pt and hangs both off their own edge at
      the room's corner gap, so the pair is a mirror image around the shutter,
      the flanks share the column the corner controls sit on, and every round
      control on the screen is one size. Confirm the mirrored pair on that
      column, or take the design's flash.
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
