import AppKit
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "SavePanelWarmup")

/// Pre-warms the NSSavePanel / NSOpenPanel ViewBridge XPC connection so that
/// user-initiated save and open actions don't hang the main thread.
///
/// On macOS, the first `NSSavePanel` (or `NSOpenPanel`) creation in a process
/// establishes a ViewBridge XPC connection to
/// `com.apple.appkit.xpc.openAndSavePanelService`. This handshake blocks on
/// a dispatch semaphore for 100 ms – 2 s+ depending on system load and whether
/// the panel service is already running. Subsequent panel creations in the same
/// process reuse the established connection and complete near-instantly.
///
/// By creating a throwaway panel during app startup on a detached (non-main)
/// task, the one-time connection cost is moved off the critical interaction
/// path. All 10+ `NSSavePanel()` / `NSOpenPanel()` call sites across the app
/// benefit automatically without any per-site changes.
///
/// The throwaway panel is created with `defer: true` (the NSWindow default),
/// so it never registers with the window server — the only side-effect is the
/// XPC connection establishment. This is the same pattern used for CLI symlink
/// installation (LUM-630) and NSSharingService discovery (LUM-646).
enum SavePanelWarmup {
    /// Call once during app launch. Idempotent — subsequent calls are no-ops.
    @MainActor
    static func warmUp() {
        Task.detached(priority: .utility) {
            let start = ContinuousClock.now
            // NSSavePanel inherits from NSPanel → NSWindow.  Initializing it
            // triggers _NSViewBridgeMakeSecureConnection which is the blocking
            // call.  The panel is never configured, displayed, or retained —
            // it exists solely to establish the process-level XPC connection.
            let _ = NSSavePanel()
            let elapsed = ContinuousClock.now - start
            let ms = elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000
            log.info("[savePanelWarmup] ViewBridge connection established in \(ms)ms")
        }
    }
}
