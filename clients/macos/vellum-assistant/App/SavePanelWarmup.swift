import AppKit
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "SavePanelWarmup")

/// Pre-warms the NSSavePanel / NSOpenPanel ViewBridge XPC connection so that
/// user-initiated save and open actions don't hang the main thread during
/// interactive use.
///
/// On macOS, the first `NSSavePanel` (or `NSOpenPanel`) creation in a process
/// establishes a ViewBridge XPC connection to
/// `com.apple.appkit.xpc.openAndSavePanelService`. This handshake blocks on
/// a dispatch semaphore for 100 ms – 2 s+ depending on system load and whether
/// the panel service is already running. Subsequent panel creations in the same
/// process reuse the established connection and complete near-instantly.
///
/// `NSSavePanel` inherits from `NSPanel` → `NSWindow` and is `@MainActor`-
/// isolated, so it **must** be created on the main thread
/// ([Apple — NSWindow](https://developer.apple.com/documentation/appkit/nswindow)).
/// We schedule the throwaway panel creation in a deferred `Task { @MainActor
/// in }` so that it runs on the main actor's queue *after*
/// `applicationDidFinishLaunching` returns — paying the one-time XPC cost
/// during an idle run-loop iteration at startup rather than during a
/// user-initiated save/open action.
///
/// All 10+ `NSSavePanel()` / `NSOpenPanel()` call sites across the app
/// benefit automatically without any per-site changes.
enum SavePanelWarmup {
    /// Call once from `applicationDidFinishLaunching`. The actual panel
    /// creation is deferred to the next main-actor turn so it does not
    /// add to the synchronous launch time.
    @MainActor
    static func warmUp() {
        Task { @MainActor in
            let start = ContinuousClock.now
            // NSSavePanel inherits from NSPanel → NSWindow.  Initializing it
            // triggers _NSViewBridgeMakeSecureConnection which blocks on a
            // dispatch semaphore.  The panel is never configured, displayed,
            // or retained — it exists solely to establish the process-level
            // XPC connection.  Created with defer: true (NSWindow default),
            // so it never registers with the window server.
            let _ = NSSavePanel()
            let elapsed = ContinuousClock.now - start
            let ms = elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000
            log.info("[savePanelWarmup] ViewBridge connection established in \(ms)ms")
        }
    }
}
