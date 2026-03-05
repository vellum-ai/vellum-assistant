# Render Churn Performance Notes

## Summary

The macOS client exhibited a continuous render loop during idle and scrolling states in chat, consuming 99.95% CPU and growing to 2.0 GB physical memory. The root cause was a cascade of high-frequency SwiftUI view invalidations triggered by per-token Combine publishes, unconditional overlay updates, and retained surface payloads that never got cleared. This document summarizes the profiling findings, the fixes applied across multiple PRs, expected improvements, and how to verify the results.

## Before State

Key findings from the process sample taken during an idle chat session:

- **1629 of 1629 main-thread samples** landed inside SwiftUI view graph updates, meaning the UI never reached a quiescent state.
- **SelectionOverlay.updateNSView** accounted for approximately 14% of all samples, continuously recalculating even when no selection was active.
- **Continuous re-render during idle** — the chat view kept invalidating and redrawing even with no new messages, user input, or scrolling.
- **Physical memory grew to 2.0 GB**, driven by retained surface HTML payloads and un-cleared attachment base64 data accumulating across the conversation history.

## Changes Made

| PR | Title | Impact |
|---|---|---|
| M0 | Profiling harness + acceptance gates | Debug counters for publish frequency |
| M2 | Decouple TaskProgressOverlay from chat list | Only react to activeSurfaceId changes |
| M4 | Tune streaming publish rate | 100 ms flush interval (from 50 ms) |
| M5 | Reduce ChatViewModel fan-out invalidation | 100 ms coalesced sub-manager forwarding |
| M6 | Compact inline surface payloads | .stripped SurfaceData for completed surfaces |
| M7 | History surface-light mode | Already implemented (mode: "light") |
| M8 | Attachment lifecycle tightening | Clear base64 data after dequeue |
| M9 | Selection-overlay containment | Disable .textSelection during streaming |
| M10 | Regression tests | Verify coalescing, stripping, clearing |
| M11 | Migrate SubagentDetailStore to @Observable | Property-level observation replaces whole-store objectWillChange; SubagentEventsReader wrapper scopes invalidation to individual subagent rows; phaseAnimator replaces TimelineView timer |

## Expected Improvements

- **CPU**: The continuous render loop should break. An idle chat session should NOT show continuous SwiftUI view graph updates; the main thread should be largely idle between user interactions.
- **Memory**: Surface HTML payloads are cleared from completed messages via `.stripped` SurfaceData (M6), and attachment base64 data is cleared after send (M8). Together these bound memory growth over long conversations.
- **Streaming**: Render frequency during active streaming drops from immediate per-token to 100 ms coalesced publishes (M4, M5, M11), with no visible UX regression in message rendering or animation smoothness.
- **Selection**: SelectionOverlay is disabled during streaming (M9), eliminating it from hot frames entirely (14% of samples reduced to approximately 0%).

## How to Verify

1. **Enable debug counters**: Set the `CHURN_DEBUG` environment variable before launching the app. This activates the profiling harness from M0, which logs publish frequencies and invalidation counts to the console.

2. **Run Instruments**: Open Instruments and attach both the **Allocations** and **Time Profiler** instruments to the app. Run for at least 5 minutes during an active chat session that includes streaming responses, idle periods, and scrolling through history.

3. **Expected results**:
   - CPU should plateau during idle periods rather than sustaining near-100% utilization.
   - Memory should remain bounded — no unbounded growth over the session lifetime.
   - No continuous render loop during idle: the main thread should show gaps between SwiftUI view graph update clusters.
   - During streaming, publish events should appear at roughly 100 ms intervals, not per-token.

## Deferred Work

- **History pagination surface data re-fetch**: When the user scrolls back into messages whose surface data has been stripped (M6), the client should lazily re-fetch the full surface payload on demand rather than retaining it in memory.
- **Per-surface lazy loading**: For very long conversations, surfaces that scroll out of the visible viewport could be unloaded and re-fetched when scrolled back into view, further bounding memory usage.
