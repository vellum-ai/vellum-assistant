import Foundation
import Observation
import Sparkle
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "UpdateManager")

/// Thin wrapper around Sparkle's `SPUUpdater` for auto-update functionality.
///
/// The appcast URL points to the public releases repo where CI publishes
/// signed ZIPs alongside an `appcast.xml`.
///
/// Uses the `@Observable` macro for property-level SwiftUI tracking. Sparkle
/// delegate callbacks (e.g. `didFindValidUpdate`) write multiple properties
/// synchronously; with `@Observable` this no longer triggers re-entrant
/// `objectWillChange.send()` cascades through the AttributeGraph.
@MainActor
@Observable
public final class UpdateManager: NSObject, SPUUpdaterDelegate {

    @ObservationIgnored private var updaterController: SPUStandardUpdaterController!

    public private(set) var isUpdateAvailable = false
    public private(set) var isDeferredUpdateReady = false
    public private(set) var availableUpdateVersion: String?

    /// The version string of the update that Sparkle has found and is about to
    /// install.  Set in `didFindValidUpdate` so the pre-update hook can include
    /// the target version in progress broadcasts and workspace commits.
    public var pendingUpdateVersion: String?

    /// Whether a newer service group release is available for Docker/managed topologies.
    public private(set) var isServiceGroupUpdateAvailable = false
    /// The version string of the available service group update, if any.
    public private(set) var serviceGroupUpdateVersion: String?

    /// Called before the app is replaced — stop the daemon so the new version
    /// can launch its own bundled daemon cleanly.  Async to allow best-effort
    /// backup and progress broadcasts before shutdown.
    @ObservationIgnored var onWillInstallUpdate: (() async -> Void)?

    /// Timer for periodic service group update checks (Docker/managed topologies).
    @ObservationIgnored private var serviceGroupCheckTimer: Timer?

    /// Lock-protected storage for the deferred install handler.  Written from
    /// any thread by the Sparkle delegate callback and read on MainActor by
    /// `installDeferredUpdateIfAvailable()`.  Using `OSAllocatedUnfairLock`
    /// eliminates the race between an async `Task` hop and a synchronous
    /// `applicationWillTerminate` call.
    @ObservationIgnored private let deferredInstallLock = OSAllocatedUnfairLock<(() -> Void)?>(initialState: nil)

    /// Monotonically increasing counter bumped by Sparkle delegate callbacks
    /// (`didFindValidUpdate` / `updaterDidNotFindUpdate`) whenever an update
    /// check completes. `checkForUpdatesAsync` observes this counter to detect
    /// completion even when the resulting `isUpdateAvailable` value equals the
    /// previous one (e.g. re-check that finds the same known update, or
    /// re-check that finds no update when none was available).
    ///
    /// `observationStream` deduplicates by `Equatable`, so we need a value that
    /// always changes between checks to signal "a new check completed".  The
    /// previous `@Published $isUpdateAvailable.values` projection emitted on
    /// every assignment regardless of equality; this counter restores that
    /// behavior without coupling the async-completion signal to
    /// `isUpdateAvailable`'s value-change semantics.
    private(set) var updateCheckCompletionGeneration: UInt64 = 0

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

    /// Trigger a background update check and wait for Sparkle's delegate to
    /// report a result, returning as soon as `didFindValidUpdate` or
    /// `updaterDidNotFindUpdate` fires.  Falls back to the current
    /// `isUpdateAvailable` state after `timeout` seconds so callers never hang.
    func checkForUpdatesAsync(timeout: TimeInterval = 5.0) async -> Bool {
        updaterController.updater.checkForUpdatesInBackground()

        return await withTaskGroup(of: Bool.self) { group in
            // Race: delegate callback vs timeout
            group.addTask { @MainActor [weak self] in
                guard let self else { return false }
                // Observe the completion-generation counter rather than
                // `isUpdateAvailable` directly: `observationStream` is
                // deduplicated by `Equatable`, so a same-value write
                // (e.g. re-check that finds the same already-known update,
                // or re-check that finds no update when none was available)
                // would not emit and this task would hang until the timeout.
                // The counter strictly increments on each delegate callback,
                // so every completion yields a new value.
                for await _ in observationStream({ self.updateCheckCompletionGeneration }).dropFirst() {
                    return self.isUpdateAvailable
                }
                return self.isUpdateAvailable
            }
            group.addTask { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return self?.isUpdateAvailable ?? false
            }
            let result = await group.next() ?? false
            group.cancelAll()
            return result
        }
    }

    /// Whether an update has been downloaded and is waiting to be installed.
    public var hasDeferredUpdate: Bool {
        deferredInstallLock.withLock { $0 != nil }
    }

    /// Install a previously deferred update immediately.
    /// Call this when the app is about to quit or when it becomes idle.
    ///
    /// `handler()` is called **synchronously** so that it executes before
    /// `applicationWillTerminate` returns and the process exits.  The
    /// pre-update async work (backup, progress broadcasts) is fired as
    /// best-effort in a detached Task — if it finishes before the process
    /// tears down, great; if not, the update still installs.
    func installDeferredUpdateIfAvailable() {
        let handler = deferredInstallLock.withLock { value -> (() -> Void)? in
            let h = value
            value = nil
            return h
        }
        guard let handler else { return }
        isDeferredUpdateReady = false
        log.info("Installing deferred update now")

        // Fire pre-update work (backup, daemon stop, broadcasts) as
        // best-effort.  This must not block the synchronous handler() call.
        if let onWillInstall = onWillInstallUpdate {
            Task { @MainActor in
                await onWillInstall()
            }
        }

        // handler() must run synchronously so applicationWillTerminate
        // cannot exit before Sparkle applies the update.
        handler()
    }

    // MARK: - Service Group Update Check

    /// Checks whether a newer service group release is available for Docker/managed topologies.
    /// For `.local` topology this is a no-op (Sparkle handles local app updates).
    func checkServiceGroupUpdate() async {
        do {
            // Resolve current topology from the lockfile
            let assistants = LockfileAssistant.loadAll()
            guard let connectedId = LockfileAssistant.loadActiveAssistantId(),
                  let assistant = assistants.first(where: { $0.assistantId == connectedId }) else {
                log.warning("Service group update check skipped: no connected assistant in lockfile")
                clearServiceGroupFlags()
                return
            }

            // Only check for Docker and managed topologies
            guard assistant.isDocker || assistant.isManaged else {
                clearServiceGroupFlags()
                return
            }

            // Fetch the latest stable release from the platform API
            let platformBase = VellumEnvironment.resolvedPlatformURL
            guard let releasesURL = URL(string: "\(platformBase)/v1/releases/?stable=true") else {
                log.error("Service group update check failed: could not construct releases URL from base \(platformBase, privacy: .public)")
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
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                log.error("Service group update check failed: releases API returned HTTP \(statusCode)")
                clearServiceGroupFlags()
                return
            }

            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            let releases = try decoder.decode([AssistantRelease].self, from: data)
            guard let latestRelease = releases.first else {
                log.warning("Service group update check: no stable releases returned")
                clearServiceGroupFlags()
                return
            }

            // Fetch the current service group version from health endpoint.
            let (decoded, _): (DaemonHealthz?, _) = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/healthz",
                timeout: 10
            ) { $0.keyDecodingStrategy = .convertFromSnakeCase }

            guard let currentVersion = decoded?.version, !currentVersion.isEmpty else {
                log.error("Service group update check failed: health endpoint returned no version")
                clearServiceGroupFlags()
                return
            }

            // Compare versions
            guard let latestParsed = VersionCompat.parse(latestRelease.version),
                  let currentParsed = VersionCompat.parse(currentVersion) else {
                log.error("Service group update check failed: could not parse versions (latest=\(latestRelease.version, privacy: .public), current=\(currentVersion, privacy: .public))")
                clearServiceGroupFlags()
                return
            }

            let isNewer = latestParsed > currentParsed

            if isNewer {
                log.info("Service group update available: \(latestRelease.version, privacy: .public) (current: \(currentVersion, privacy: .public))")
                isServiceGroupUpdateAvailable = true
                serviceGroupUpdateVersion = latestRelease.version
            } else {
                clearServiceGroupFlags()
            }
        } catch {
            log.error("Service group update check failed: \(error.localizedDescription, privacy: .public)")
            clearServiceGroupFlags()
        }
    }

    /// Resets service group update flags to their default (no update available) state.
    func clearServiceGroupFlags() {
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
            await self.onWillInstallUpdate?()
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
            self.pendingUpdateVersion = item.displayVersionString
            self.updateCheckCompletionGeneration &+= 1
        }
    }

    /// Called when no valid update is found.  Clears the flag in case a
    /// previously-advertised update was pulled from the appcast.
    /// Preserves `isUpdateAvailable` when a deferred update is already
    /// staged — a subsequent "not found" check shouldn't hide the toolbar
    /// button while an update is downloaded and ready to install.
    nonisolated public func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        Task { @MainActor in
            defer { self.updateCheckCompletionGeneration &+= 1 }
            guard !self.isDeferredUpdateReady else { return }
            self.isUpdateAvailable = false
            self.availableUpdateVersion = nil
            self.pendingUpdateVersion = nil
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
                self.pendingUpdateVersion = nil
            }
        }
    }
}
