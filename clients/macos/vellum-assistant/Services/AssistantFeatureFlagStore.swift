import Combine
import Foundation
import VellumAssistantShared

/// Caches assistant-scoped feature flags for the app session so SwiftUI views
/// can read resolved values without disk access during body evaluation.
@MainActor
final class AssistantFeatureFlagStore: ObservableObject {
    @Published private var resolvedFlags: [String: Bool]

    private let registryDefaults: [String: Bool]
    private let readConfig: () -> [String: Any]
    private var flagChangeCancellable: AnyCancellable?

    init(
        notificationCenter: NotificationCenter = .default,
        registry: FeatureFlagRegistry? = loadFeatureFlagRegistry(),
        readConfig: @escaping () -> [String: Any] = { WorkspaceConfigIO.read() }
    ) {
        self.readConfig = readConfig
        self.registryDefaults = AssistantFeatureFlagResolver.registryDefaults(from: registry)
        self.resolvedFlags = AssistantFeatureFlagResolver.resolvedFlags(
            config: readConfig(),
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

    func reloadFromDisk() {
        resolvedFlags = AssistantFeatureFlagResolver.resolvedFlags(
            config: readConfig(),
            registryDefaults: registryDefaults
        )
    }
}
