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

    /// Closure provided by Sparkle to trigger an immediate install-and-relaunch.
    /// Stored when a background update is ready but the app is actively in use.
    /// Called later (e.g. on quit or when idle) to apply the deferred update.
    private var deferredInstallHandler: (() -> Void)?

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
        deferredInstallHandler != nil
    }

    /// Install a previously deferred update immediately.
    /// Call this when the app is about to quit or when it becomes idle.
    func installDeferredUpdateIfAvailable() {
        guard let handler = deferredInstallHandler else { return }
        log.info("Installing deferred update now")
        deferredInstallHandler = nil
        onWillInstallUpdate?()
        handler()
    }

    // MARK: - SPUUpdaterDelegate

    nonisolated public func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        Task { @MainActor in
            log.info("Will install update \(item.displayVersionString)")
            onWillInstallUpdate?()
        }
    }

    /// Intercept Sparkle's install-on-quit to prevent a second app process from
    /// appearing while the user is actively working. Returns `false` to tell
    /// Sparkle we will handle the relaunch ourselves via the saved handler.
    nonisolated public func updater(
        _ updater: SPUUpdater,
        willInstallUpdateOnQuit item: SUAppcastItem,
        immediateInstallationBlock immediateInstallHandler: @escaping () -> Void
    ) -> Bool {
        Task { @MainActor in
            log.info("Update \(item.displayVersionString) ready — deferring install until quit")
            self.deferredInstallHandler = immediateInstallHandler
        }
        return false
    }
}
