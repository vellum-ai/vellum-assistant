import Foundation
import Sparkle
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "UpdateManager")

/// Thin wrapper around Sparkle's `SPUUpdater` for auto-update functionality.
///
/// The appcast URL points to the public releases repo where CI publishes
/// signed ZIPs alongside an `appcast.xml`.
@MainActor
public final class UpdateManager: NSObject, ObservableObject, SPUUpdaterDelegate {

    private var updaterController: SPUStandardUpdaterController!

    @Published public private(set) var isUpdateAvailable = false
    @Published public private(set) var isDeferredUpdateReady = false
    @Published public private(set) var availableUpdateVersion: String?

    /// Whether a newer service group release is available for Docker/managed topologies.
    @Published public private(set) var isServiceGroupUpdateAvailable = false
    /// The version string of the available service group update, if any.
    @Published public private(set) var serviceGroupUpdateVersion: String?

    /// Called before the app is replaced — stop the daemon so the new version
    /// can launch its own bundled daemon cleanly.
    var onWillInstallUpdate: (() -> Void)?

    /// Timer for periodic service group update checks (Docker/managed topologies).
    private var serviceGroupCheckTimer: Timer?

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
            log.error("Failed to start Sparkle updater: \(error.localizedDescription, privacy: .public)")
        }

        // Run an initial service group update check and schedule periodic re-checks
        // every hour (matching Sparkle's default automatic check interval).
        Task { await checkServiceGroupUpdate() }
        serviceGroupCheckTimer?.invalidate()
        serviceGroupCheckTimer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.checkServiceGroupUpdate()
            }
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

    // MARK: - Menu Item Helpers

    /// Context-aware title for the update menu item.
    /// Returns "Update Available..." when a Sparkle update is ready,
    /// "Update Available (vX.Y.Z)" when a service group update is available,
    /// "Check for Updates..." when a manual check can be triggered,
    /// or "Up to Date" when neither applies.
    public var updateMenuItemTitle: String {
        if isUpdateAvailable { return "Update Available..." }
        if isServiceGroupUpdateAvailable, let v = serviceGroupUpdateVersion {
            return "Update Available (\(v))"
        }
        if canCheckForUpdates { return "Check for Updates..." }
        return "Up to Date"
    }

    /// Whether the update menu item should accept user interaction.
    public var updateMenuItemIsEnabled: Bool {
        isUpdateAvailable || isServiceGroupUpdateAvailable || canCheckForUpdates
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
        isDeferredUpdateReady = false
        log.info("Installing deferred update now")
        onWillInstallUpdate?()
        handler()
    }

    // MARK: - Service Group Update Check

    /// Checks whether a newer service group release is available for Docker/managed topologies.
    /// For `.local` topology this is a no-op (Sparkle handles local app updates).
    /// Failures are silently swallowed — the menu simply stays in "Check for Updates…" state.
    func checkServiceGroupUpdate() async {
        do {
            // Resolve current topology from the lockfile
            let assistants = LockfileAssistant.loadAll()
            guard let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId"),
                  let assistant = assistants.first(where: { $0.assistantId == connectedId }) else {
                clearServiceGroupFlags()
                return
            }

            // Only check for Docker and managed topologies
            guard assistant.isDocker || assistant.isManaged else {
                clearServiceGroupFlags()
                return
            }

            // Fetch the latest stable release from the platform API
            let platformBase = AuthService.shared.baseURL
            guard let releasesURL = URL(string: "\(platformBase)/v1/releases/?stable=true") else {
                clearServiceGroupFlags()
                return
            }

            var request = URLRequest(url: releasesURL)
            request.httpMethod = "GET"
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let token = await SessionTokenManager.getTokenAsync() {
                request.setValue(token, forHTTPHeaderField: "X-Session-Token")
            }
            if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId") {
                request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
            }

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                clearServiceGroupFlags()
                return
            }

            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            let releases = try decoder.decode([AssistantRelease].self, from: data)
            guard let latestRelease = releases.first else {
                clearServiceGroupFlags()
                return
            }

            // Fetch the current service group version from healthz
            let (decoded, _): (DaemonHealthz?, _) = try await GatewayHTTPClient.get(
                path: "assistants/\(connectedId)/healthz",
                timeout: 10
            ) { $0.keyDecodingStrategy = .convertFromSnakeCase }

            guard let currentVersion = decoded?.version, !currentVersion.isEmpty else {
                clearServiceGroupFlags()
                return
            }

            // Compare versions
            guard let latestParsed = VersionCompat.parse(latestRelease.version),
                  let currentParsed = VersionCompat.parse(currentVersion) else {
                clearServiceGroupFlags()
                return
            }

            let isNewer: Bool = {
                if latestParsed.major != currentParsed.major { return latestParsed.major > currentParsed.major }
                if latestParsed.minor != currentParsed.minor { return latestParsed.minor > currentParsed.minor }
                return latestParsed.patch > currentParsed.patch
            }()

            if isNewer {
                isServiceGroupUpdateAvailable = true
                serviceGroupUpdateVersion = latestRelease.version
            } else {
                clearServiceGroupFlags()
            }
        } catch {
            // Failures silently clear the flags — no error state in the menu.
            clearServiceGroupFlags()
        }
    }

    /// Resets service group update flags to their default (no update available) state.
    private func clearServiceGroupFlags() {
        isServiceGroupUpdateAvailable = false
        serviceGroupUpdateVersion = nil
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
            log.info("Will install update \(item.displayVersionString, privacy: .public)")
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
            self.isDeferredUpdateReady = true
        }
        Task { @MainActor in
            log.info("Update \(item.displayVersionString, privacy: .public) ready — deferring install until quit")
        }
        return false
    }

    /// Called when Sparkle finds a valid update in the appcast (automatic or
    /// manual check).  Sets `isUpdateAvailable` so the top-bar button appears.
    nonisolated public func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        Task { @MainActor in
            log.info("Found valid update: \(item.displayVersionString, privacy: .public)")
            self.isUpdateAvailable = true
            self.availableUpdateVersion = item.displayVersionString
        }
    }

    /// Called when no valid update is found.  Clears the flag in case a
    /// previously-advertised update was pulled from the appcast.
    nonisolated public func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        Task { @MainActor in
            self.isUpdateAvailable = false
            self.availableUpdateVersion = nil
        }
    }

    /// Called when the user makes a choice in Sparkle's update dialog.
    /// If they skip this version, hide the button.  Dismiss/install leave it.
    nonisolated public func updater(
        _ updater: SPUUpdater,
        userDidMake choice: SPUUserUpdateChoice,
        forUpdate updateItem: SUAppcastItem,
        state: SPUUserUpdateState
    ) {
        Task { @MainActor in
            if choice == .skip {
                log.info("User skipped update \(updateItem.displayVersionString, privacy: .public)")
                self.isUpdateAvailable = false
                self.availableUpdateVersion = nil
            }
        }
    }
}
