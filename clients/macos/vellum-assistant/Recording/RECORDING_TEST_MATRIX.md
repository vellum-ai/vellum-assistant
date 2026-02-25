# Recording Subsystem — Manual QA Test Matrix

This checklist covers monitor compatibility scenarios that require manual
validation. Automated tests in `ScreenRecorderTests.swift` cover dimension
normalization, fallback config building, and error code mapping — those are
**not** duplicated here.

Use this as a pass/fail checklist when validating recording behavior across
display configurations. Each item should produce a valid `.mov` file (or a
graceful error where noted).

---

## Display Configurations

### Single Display

- [ ] Built-in Retina display only (e.g. MacBook Pro 14" — 2x scale)
- [ ] Built-in non-Retina display (if available — 1x scale)
- [ ] Single external display only (lid closed, 1x scale)
- [ ] Single external display only (lid closed, 2x HiDPI scale)

### Multi-Display

- [ ] Built-in + one external at same DPI (both 2x Retina)
- [ ] Built-in + one external at different DPI (mixed — 2x built-in, 1x external)
- [ ] Two external displays, no built-in (lid closed, same DPI)
- [ ] Two external displays, no built-in (lid closed, different DPI)
- [ ] Three or more displays connected simultaneously

### Unusual Display Types

- [ ] Ultrawide monitor (e.g. 3440x1440 or 5120x1440)
- [ ] 5K display (e.g. Apple Studio Display — 5120x2880)
- [ ] 4K display at non-native scaled resolution (e.g. "Looks like 1920x1080")
- [ ] Display rotated 90 degrees (portrait orientation)
- [ ] Display rotated 180 degrees (inverted)
- [ ] Display with non-standard refresh rate (e.g. 120Hz, 144Hz)
- [ ] Virtual/dummy display adapter (e.g. headless HDMI dongle)

---

## Capture Scenarios

### Display Capture

- [ ] Record the primary (main) display
- [ ] Record a secondary (non-main) display
- [ ] Record a display that is NOT where the app's menu bar icon lives
- [ ] Record each display in a mixed-DPI setup — verify scale factor is correct for each

### Window Capture

- [ ] Record a window on the primary display
- [ ] Record a window on a secondary display
- [ ] Record a window on a lower-DPI display while the app is on a higher-DPI display
- [ ] Record a very small window (close to 128px on one axis)
- [ ] Record a maximized/full-screen window

### Cross-Display Scenarios

- [ ] Start recording display A, then move the target app to display B — verify recording continues on display A
- [ ] Start window capture, then drag the window to a different display mid-recording — verify the recording captures the move
- [ ] Start window capture on a 2x display, drag window to 1x display — verify output is valid

---

## Runtime Events

### Hot-Plug (Display Connect/Disconnect)

- [ ] Disconnect the recorded display during an active recording — verify graceful stop with `.sourceUnavailable` error and partial file cleanup
- [ ] Disconnect a non-recorded display during an active recording — verify recording continues unaffected
- [ ] Connect a new display during an active recording — verify recording continues unaffected
- [ ] Rapidly disconnect and reconnect the recorded display — verify no crash or resource leak

### Display Mode Changes

- [ ] Change the recorded display's resolution during an active recording (System Settings > Displays) — verify recording continues
- [ ] Change display arrangement (drag displays in System Settings) during recording — verify recording continues
- [ ] Toggle display mirroring on/off during recording

### Sleep/Wake

- [ ] Put the Mac to sleep during recording, then wake — verify recording state is consistent (either resumed or cleanly stopped)
- [ ] Close laptop lid (with external display) during recording — verify recording of the external display continues or stops gracefully
- [ ] Trigger display sleep (hot corner or energy saver) during recording — verify behavior

---

## Edge Cases

### Extreme Dimensions

- [ ] Record a display at exactly 4096px on its longest axis — verify no downscaling
- [ ] Record a display that exceeds 4096px native (e.g. 5K at 2x = 5120px) — verify fallback chain kicks in and downscaling is correct
- [ ] Record a window sized to exactly 128x128 logical pixels — verify minimum dimension handling
- [ ] Record a window smaller than 128 logical pixels on one axis — verify minimum clamping

### Permission Edge Cases

- [ ] Start recording without screen recording permission granted — verify `.permissionDenied` error
- [ ] Revoke screen recording permission mid-recording (System Settings > Privacy) — verify graceful error handling
- [ ] Start recording with microphone permission denied when `includeMicrophone: true` — verify recording proceeds without mic track

### Resource Constraints

- [ ] Start a recording while disk space is very low — verify writer setup failure is handled gracefully
- [ ] Start two recordings simultaneously (if possible through the API) — verify no corruption or resource conflicts
- [ ] Record for an extended period (30+ minutes) — verify file integrity and no memory growth

### No Display Available

- [ ] Attempt to record with all displays disconnected (if testable, e.g. lid closed + external removed) — verify appropriate error

---

## Fallback Chain Verification

These scenarios verify that the encoder fallback chain (primary -> halved -> HEVC -> 720p) works correctly under real hardware conditions. The fallback logic is unit-tested, but hardware codec behavior can only be validated on real devices.

- [ ] Force primary config failure (e.g. by recording a 5K display where H.264 at full resolution may not produce frames) — verify automatic fallback to halved or HEVC config
- [ ] Verify telemetry logs show the correct `configLabel` when a fallback is used
- [ ] Verify the `activeConfigLabel` property reflects which config succeeded
- [ ] On a Mac without HEVC hardware support (older Intel Mac) — verify the HEVC step is skipped and fallback goes directly to 720p
- [ ] Verify 720p final fallback produces a valid recording on any Mac hardware

---

## Validation Checklist (For Each Test Above)

For each checked scenario, verify:

1. The output `.mov` file plays correctly in QuickTime Player
2. Video dimensions match the expected encode config (check with `ffprobe` or QuickTime inspector)
3. Audio tracks are present when `includeAudio`/`includeMicrophone` were enabled
4. No crash, hang, or zombie process after recording stops
5. Telemetry logs (`RecordingTelemetry`) contain accurate source dimensions, scale factor, and config label
