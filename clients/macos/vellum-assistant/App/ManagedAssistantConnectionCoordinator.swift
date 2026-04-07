import Foundation
import VellumAssistantShared

@MainActor
protocol ManagedAssistantBootstrapProviding {
    func ensureManagedAssistant(
        name: String?,
        description: String?,
        anthropicApiKey: String?,
        multiAssistantEnabled: Bool
    ) async throws -> ManagedBootstrapOutcome
}

extension ManagedAssistantBootstrapService: ManagedAssistantBootstrapProviding {}

struct ManagedAssistantConnectionResult {
    let assistant: PlatformAssistant
    let reusedExisting: Bool
}

enum ManagedAssistantConnectionCoordinatorError: LocalizedError {
    case persistenceFailed

    var errorDescription: String? {
        switch self {
        case .persistenceFailed:
            return "Failed to save assistant configuration. Please try again."
        }
    }
}

@MainActor
final class ManagedAssistantConnectionCoordinator {
    private let bootstrapService: ManagedAssistantBootstrapProviding
    private let userDefaults: UserDefaults
    private let runtimeURLProvider: () -> String
    private let updateAssistantTag: (String?) -> Void
    private let lockfilePath: String?
    private let dateProvider: () -> Date
    private let multiAssistantEnabledProvider: () -> Bool

    init(
        bootstrapService: ManagedAssistantBootstrapProviding,
        userDefaults: UserDefaults = .standard,
        runtimeURLProvider: @escaping () -> String,
        updateAssistantTag: @escaping (String?) -> Void = { assistantId in
            SentryDeviceInfo.updateAssistantTag(assistantId)
        },
        lockfilePath: String? = nil,
        dateProvider: @escaping () -> Date = Date.init,
        multiAssistantEnabledProvider: @escaping () -> Bool = {
            // Read the feature flag directly at the call site, per the
            // codebase convention (see SettingsPanel.swift, MainWindowView.swift,
            // PanelCoordinator.swift). Constructing a fresh store is cheap —
            // `isEnabled` only reads in-memory/cached flag state.
            AssistantFeatureFlagStore().isEnabled("multi-platform-assistant")
        }
    ) {
        self.bootstrapService = bootstrapService
        self.userDefaults = userDefaults
        self.runtimeURLProvider = runtimeURLProvider
        self.updateAssistantTag = updateAssistantTag
        self.lockfilePath = lockfilePath
        self.dateProvider = dateProvider
        self.multiAssistantEnabledProvider = multiAssistantEnabledProvider
    }

    convenience init(
        userDefaults: UserDefaults = .standard,
        updateAssistantTag: @escaping (String?) -> Void = { assistantId in
            SentryDeviceInfo.updateAssistantTag(assistantId)
        },
        lockfilePath: String? = nil,
        dateProvider: @escaping () -> Date = Date.init
    ) {
        self.init(
            bootstrapService: ManagedAssistantBootstrapService.shared,
            userDefaults: userDefaults,
            runtimeURLProvider: { AuthService.shared.baseURL },
            updateAssistantTag: updateAssistantTag,
            lockfilePath: lockfilePath,
            dateProvider: dateProvider
        )
    }

    func activateManagedAssistant() async throws -> ManagedAssistantConnectionResult {
        let outcome = try await bootstrapService.ensureManagedAssistant(
            name: nil,
            description: nil,
            anthropicApiKey: nil,
            multiAssistantEnabled: multiAssistantEnabledProvider()
        )
        return try persistManagedAssistant(
            outcome.assistant,
            reusedExisting: outcome.reusedExisting
        )
    }

    /// Reauth happens after the server session expires, so any persisted
    /// organization selection may belong to the previous account/session.
    /// Force a fresh org lookup before activating the managed assistant.
    func activateManagedAssistantAfterReauth() async throws -> ManagedAssistantConnectionResult {
        userDefaults.removeObject(forKey: "connectedOrganizationId")
        return try await activateManagedAssistant()
    }

    private func persistManagedAssistant(
        _ assistant: PlatformAssistant,
        reusedExisting: Bool
    ) throws -> ManagedAssistantConnectionResult {
        let runtimeURL = runtimeURLProvider()

        let hatchedAt = dateProvider().iso8601WithFractionalSecondsString

        let success = LockfileAssistant.ensureManagedEntry(
            assistantId: assistant.id,
            runtimeUrl: runtimeURL,
            hatchedAt: hatchedAt,
            lockfilePath: lockfilePath
        )

        guard success else {
            throw ManagedAssistantConnectionCoordinatorError.persistenceFailed
        }

        LockfileAssistant.setActiveAssistantId(assistant.id, lockfilePath: lockfilePath)
        if userDefaults.object(forKey: "collectUsageData") == nil {
            userDefaults.set(true, forKey: "collectUsageData")
        }
        if userDefaults.object(forKey: "sendDiagnostics") == nil {
            userDefaults.set(true, forKey: "sendDiagnostics")
        }
        userDefaults.set(true, forKey: "tosAccepted")

        // Clear stale cached feature flags from any previous assistant so the
        // new managed assistant resolves flags from its own configuration.
        AssistantFeatureFlagResolver.clearCachedFlags()

        updateAssistantTag(assistant.id)

        return ManagedAssistantConnectionResult(
            assistant: assistant,
            reusedExisting: reusedExisting
        )
    }
}

private extension ManagedBootstrapOutcome {
    var assistant: PlatformAssistant {
        switch self {
        case .reusedExisting(let assistant), .createdNew(let assistant):
            return assistant
        }
    }

    var reusedExisting: Bool {
        switch self {
        case .reusedExisting:
            return true
        case .createdNew:
            return false
        }
    }
}
