import Foundation
import Sparkle
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "UpdateManager")

/// Thin wrapper around Sparkle's `SPUUpdater` for auto-update functionality.
///
/// The appcast URL points to the public releases repo where CI publishes
/// signed ZIPs alongside an `appcast.xml`.
@MainActor
public final class UpdateManager: NSObject, SPUUpdaterDelegate {

    private var updaterController: SPUStandardUpdaterController!

    /// Called before the app is replaced — stop the daemon so the new version
    /// can launch its own bundled daemon cleanly.
    var onWillInstallUpdate: (() -> Void)?

    /// Lock-protected storage for the deferred install handler.  Written from
    /// any thread by the Sparkle delegate callback and read on MainActor by
    /// `installDeferredUpdateIfAvailable()`.  Using `OSAllocatedUnfairLock`
    /// eliminates the race between an async `Task` hop and a synchronous
    /// `applicationWillTerminate` call.
    private let deferredInstallLock = OSAllocatedUnfairLock<(() -> Void)?>(initialState: nil)

    override init() {
        super.init()
        updaterController = SPUStandardUpdaterController(
            startingUpdater: false,
            updaterDelegate: self,
            userDriverDelegate: nil
        )
    }

    /// Begin automatic background update checks.
    func startAutomaticChecks() {
        do {
            try updaterController.updater.start()
            log.info("Sparkle auto-update checks started")
        } catch {
            log.error("Failed to start Sparkle updater: \(error.localizedDescription)")
        }
    }

    /// Manually trigger "Check for Updates…" (shows UI).
    public func checkForUpdates() {
        updaterController.checkForUpdates(nil)
    }

    /// Whether the "Check for Updates…" menu item should be enabled.
    public var canCheckForUpdates: Bool {
        updaterController.updater.canCheckForUpdates
    }

    /// Whether an update has been downloaded and is waiting to be installed.
    public var hasDeferredUpdate: Bool {
        deferredInstallLock.withLock { $0 != nil }
    }

    /// Install a previously deferred update immediately.
    /// Call this when the app is about to quit or when it becomes idle.
    func installDeferredUpdateIfAvailable() {
        let handler = deferredInstallLock.withLock { value -> (() -> Void)? in
            let h = value
            value = nil
            return h
        }
        guard let handler else { return }
        log.info("Installing deferred update now")
        onWillInstallUpdate?()
        handler()
    }

    // MARK: - SPUUpdaterDelegate

    /// Called when Sparkle is about to install an update right now (interactive
    /// installs). Delegates to `onWillInstallUpdate` so the daemon can be
    /// stopped before the app is replaced.
    ///
    /// Marked `nonisolated` because Sparkle's XPC installer may invoke the
    /// delegate from a non-main thread despite the protocol's @MainActor
    /// annotation.  The Task hop ensures property access stays on MainActor.
    nonisolated public func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        Task { @MainActor in
            log.info("Will install update \(item.displayVersionString)")
            // Skip the daemon stop if we have a deferred update — the daemon
            // will be stopped when the deferred handler is invoked at quit.
            guard !self.hasDeferredUpdate else { return }
            self.onWillInstallUpdate?()
        }
    }

    /// Intercept Sparkle's install-on-quit to prevent a second app process from
    /// appearing while the user is actively working.  Returns `false` to tell
    /// Sparkle we will handle the relaunch ourselves via the saved handler.
    ///
    /// The handler is stored synchronously under a lock so that a subsequent
    /// `applicationWillTerminate` → `installDeferredUpdateIfAvailable()` call
    /// is guaranteed to see it, even if the run loop hasn't drained yet.
    nonisolated public func updater(
        _ updater: SPUUpdater,
        willInstallUpdateOnQuit item: SUAppcastItem,
        immediateInstallationBlock immediateInstallHandler: @escaping () -> Void
    ) -> Bool {
        deferredInstallLock.withLock { $0 = immediateInstallHandler }
        Task { @MainActor in
            log.info("Update \(item.displayVersionString) ready — deferring install until quit")
        }
        return false
    }
}
