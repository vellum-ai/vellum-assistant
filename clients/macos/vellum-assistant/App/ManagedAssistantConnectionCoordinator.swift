import Foundation
import VellumAssistantShared

@MainActor
protocol ManagedAssistantBootstrapProviding {
    func ensureManagedAssistant(
        name: String?,
        description: String?,
        anthropicApiKey: String?
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

    init(
        bootstrapService: ManagedAssistantBootstrapProviding = ManagedAssistantBootstrapService.shared,
        userDefaults: UserDefaults = .standard,
        runtimeURLProvider: @escaping () -> String = { AuthService.shared.baseURL },
        updateAssistantTag: @escaping (String?) -> Void = { assistantId in
            SentryDeviceInfo.updateAssistantTag(assistantId)
        },
        lockfilePath: String? = nil,
        dateProvider: @escaping () -> Date = Date.init
    ) {
        self.bootstrapService = bootstrapService
        self.userDefaults = userDefaults
        self.runtimeURLProvider = runtimeURLProvider
        self.updateAssistantTag = updateAssistantTag
        self.lockfilePath = lockfilePath
        self.dateProvider = dateProvider
    }

    func activateManagedAssistant() async throws -> ManagedAssistantConnectionResult {
        let outcome = try await bootstrapService.ensureManagedAssistant(
            name: nil,
            description: nil,
            anthropicApiKey: nil
        )
        let assistant = outcome.assistant
        let runtimeURL = runtimeURLProvider()

        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let hatchedAt = isoFormatter.string(from: dateProvider())

        let success = LockfileAssistant.ensureManagedEntry(
            assistantId: assistant.id,
            runtimeUrl: runtimeURL,
            hatchedAt: hatchedAt,
            lockfilePath: lockfilePath
        )

        guard success else {
            throw ManagedAssistantConnectionCoordinatorError.persistenceFailed
        }

        userDefaults.set(assistant.id, forKey: "connectedAssistantId")
        if userDefaults.object(forKey: "collectUsageData") == nil {
            userDefaults.set(true, forKey: "collectUsageData")
        }
        if userDefaults.object(forKey: "sendDiagnostics") == nil {
            userDefaults.set(true, forKey: "sendDiagnostics")
        }
        userDefaults.set(true, forKey: "tosAccepted")

        updateAssistantTag(assistant.id)

        return ManagedAssistantConnectionResult(
            assistant: assistant,
            reusedExisting: outcome.reusedExisting
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
