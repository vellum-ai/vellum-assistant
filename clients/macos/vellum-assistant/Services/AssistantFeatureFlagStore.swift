import Combine
import Foundation
import VellumAssistantShared

/// Caches assistant-scoped feature flags for the app session so SwiftUI views
/// can read resolved values without evaluating config on every render.
@MainActor
final class AssistantFeatureFlagStore: ObservableObject {
    @Published private var resolvedFlags: [String: Bool]

    private let registryDefaults: [String: Bool]
    private let settingsClient: SettingsClientProtocol
    private var flagChangeCancellable: AnyCancellable?

    init(
        notificationCenter: NotificationCenter = .default,
        registry: FeatureFlagRegistry? = loadFeatureFlagRegistry(),
        settingsClient: SettingsClientProtocol = SettingsClient()
    ) {
        self.settingsClient = settingsClient
        self.registryDefaults = AssistantFeatureFlagResolver.registryDefaults(from: registry)
        // Start with registry defaults; daemon config will be applied once fetched.
        self.resolvedFlags = registryDefaults

        flagChangeCancellable = notificationCenter.publisher(for: .assistantFeatureFlagDidChange)
            .receive(on: RunLoop.main)
            .sink { [weak self] notification in
                guard let self else { return }

                if let key = notification.userInfo?["key"] as? String,
                   let enabled = notification.userInfo?["enabled"] as? Bool {
                    self.resolvedFlags[key] = enabled
                    return
                }

                Task { await self.reloadFromDaemon() }
            }

        // Fetch config from daemon asynchronously to overlay persisted overrides.
        Task { await self.reloadFromDaemon() }
    }

    func isEnabled(_ key: String) -> Bool {
        resolvedFlags[key] ?? registryDefaults[key] ?? true
    }

    func reloadFromDaemon() async {
        let config = await settingsClient.fetchConfig() ?? [:]
        resolvedFlags = AssistantFeatureFlagResolver.resolvedFlags(
            config: config,
            registryDefaults: registryDefaults
        )
    }
}
