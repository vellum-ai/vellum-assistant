import Combine
import Foundation
import Observation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AssistantFeatureFlagStore")

/// Caches assistant-scoped feature flags for the app session so SwiftUI views
/// can read resolved values without disk access during body evaluation.
///
/// On initialization, flags are resolved from the local registry + UserDefaults
/// cache (gateway may not be connected yet). Once the daemon connection is
/// established, call ``reloadFromGateway()`` to fetch the authoritative state
/// from the gateway API.  The ``feature_flags_changed`` SSE event triggers
/// subsequent gateway refreshes when flag files change on disk.
///
/// Uses the `@Observable` macro so views only re-evaluate when the specific
/// flags they read via ``isEnabled(_:)`` actually change, eliminating
/// objectWillChange cascades into every observing view.
@MainActor
@Observable
final class AssistantFeatureFlagStore {
    private var resolvedFlags: [String: Bool]

    @ObservationIgnored private let registryDefaults: [String: Bool]
    @ObservationIgnored private var flagChangeCancellable: AnyCancellable?
    @ObservationIgnored private let featureFlagClient: FeatureFlagClientProtocol

    init(
        notificationCenter: NotificationCenter = .default,
        registry: FeatureFlagRegistry? = loadFeatureFlagRegistry(),
        featureFlagClient: FeatureFlagClientProtocol = FeatureFlagClient()
    ) {
        self.registryDefaults = AssistantFeatureFlagResolver.registryDefaults(from: registry)
        self.featureFlagClient = featureFlagClient
        // Bootstrap from local sources (cache + disk) so flags are available
        // immediately, before the gateway connection is established.
        self.resolvedFlags = AssistantFeatureFlagResolver.resolvedFlags(
            registryDefaults: self.registryDefaults
        )

        flagChangeCancellable = notificationCenter.publisher(for: .assistantFeatureFlagDidChange)
            .receive(on: RunLoop.main)
            .sink { [weak self] notification in
                guard let self else { return }

                if let key = notification.userInfo?["key"] as? String,
                   let enabled = notification.userInfo?["enabled"] as? Bool {
                    self.resolvedFlags[key] = enabled
                    return
                }

                self.reloadFromDisk()
            }
    }

    func isEnabled(_ key: String) -> Bool {
        resolvedFlags[key] ?? registryDefaults[key] ?? true
    }

    /// Reload flags from local disk + UserDefaults cache.
    /// Used as a fallback when the gateway is not reachable.
    func reloadFromDisk() {
        resolvedFlags = AssistantFeatureFlagResolver.resolvedFlags(
            registryDefaults: registryDefaults
        )
    }

    /// Fetch the authoritative flag state from the gateway API and update the
    /// local cache.  Falls back to ``reloadFromDisk()`` on network errors so
    /// the UI always reflects the best-known state.
    func reloadFromGateway() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let flags = try await self.featureFlagClient.getFeatureFlags()
                let merged = Dictionary(uniqueKeysWithValues: flags.map { ($0.key, $0.enabled) })
                // Persist into the UserDefaults cache so the next cold-start
                // picks up values from the last successful gateway fetch.
                AssistantFeatureFlagResolver.writeCachedFlags(merged)
                self.resolvedFlags = self.registryDefaults
                    .merging(merged) { _, new in new }
                log.info("Feature flags refreshed from gateway (\(merged.count) flags)")
            } catch {
                log.warning("Gateway feature-flag fetch failed, falling back to disk: \(error.localizedDescription)")
                self.reloadFromDisk()
            }
        }
    }
}
