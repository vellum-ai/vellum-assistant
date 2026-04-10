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

/// Abstraction over the live gateway/SSE connection so the coordinator can
/// tear it down and bring it back up when switching between managed
/// assistants. Injected so tests can spy on call order without needing a
/// real `GatewayConnectionManager`. Production wiring lives in the site
/// that constructs the coordinator with a live SSE connection available
/// (e.g. from `AppDelegate`).
@MainActor
protocol ManagedAssistantConnectionController {
    /// Disconnect the current gateway/SSE connection. Must complete before
    /// returning so the coordinator can serialize teardown and bring-up.
    func teardown() async
    /// Re-establish the gateway/SSE connection for the assistant that is
    /// currently marked active in the lockfile.
    func bringUp(for assistant: LockfileAssistant) async
}

struct ManagedAssistantConnectionResult {
    let assistant: PlatformAssistant
    let reusedExisting: Bool
}

enum ManagedAssistantConnectionCoordinatorError: LocalizedError {
    case persistenceFailed
    case multiAssistantNotEnabled
    case assistantNotFound(String)
    case missingConnectionController

    var errorDescription: String? {
        switch self {
        case .persistenceFailed:
            return "Failed to save assistant configuration. Please try again."
        case .multiAssistantNotEnabled:
            return "Switching between managed assistants is not available."
        case .assistantNotFound(let id):
            return "Could not find assistant \(id) in the lockfile."
        case .missingConnectionController:
            return "Cannot switch assistants without an active connection."
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
    private let connectionController: ManagedAssistantConnectionController?

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
            // Read the feature flag via the static resolver (same underlying
            // source `AssistantFeatureFlagStore.isEnabled` reads from) without
            // allocating a new store + NotificationCenter subscriber on every
            // `activateManagedAssistant()` call.
            AssistantFeatureFlagResolver.isEnabled("multi-platform-assistant")
        },
        connectionController: ManagedAssistantConnectionController? = nil
    ) {
        self.bootstrapService = bootstrapService
        self.userDefaults = userDefaults
        self.runtimeURLProvider = runtimeURLProvider
        self.updateAssistantTag = updateAssistantTag
        self.lockfilePath = lockfilePath
        self.dateProvider = dateProvider
        self.multiAssistantEnabledProvider = multiAssistantEnabledProvider
        self.connectionController = connectionController
    }

    convenience init(
        userDefaults: UserDefaults = .standard,
        updateAssistantTag: @escaping (String?) -> Void = { assistantId in
            SentryDeviceInfo.updateAssistantTag(assistantId)
        },
        lockfilePath: String? = nil,
        dateProvider: @escaping () -> Date = Date.init,
        connectionController: ManagedAssistantConnectionController? = nil
    ) {
        self.init(
            bootstrapService: ManagedAssistantBootstrapService.shared,
            userDefaults: userDefaults,
            runtimeURLProvider: { AuthService.shared.baseURL },
            updateAssistantTag: updateAssistantTag,
            lockfilePath: lockfilePath,
            dateProvider: dateProvider,
            connectionController: connectionController
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

    /// Switch the active managed assistant to an already-persisted entry in
    /// the lockfile. Tears down the current SSE/gateway connection, flips
    /// `activeAssistantId`, clears the feature-flag cache, and brings up a
    /// fresh connection for the new assistant — in that order.
    ///
    /// Only callable when the `multi-platform-assistant` flag is enabled.
    /// The UI entry point also gates this, but we check again as defense in
    /// depth.
    ///
    /// Unlike `activateManagedAssistant()`, this method **requires** a
    /// `connectionController` to have been injected into the coordinator.
    /// Switching without an active connection is nonsensical — there's
    /// nothing to tear down and nothing to bring up — so a nil controller
    /// would leave the caller with a half-switched state (new
    /// `activeAssistantId`, old SSE) that falsely reports success. The
    /// activate path tolerates a nil controller because the AppDelegate
    /// owns bring-up there via `setupGatewayConnectionManager()`; that
    /// asymmetry is intentional.
    ///
    /// The returned `ManagedAssistantConnectionResult.reusedExisting` is
    /// always `true` here: switch never creates a new `PlatformAssistant`
    /// server-side, it only re-points the local active assistant at one
    /// that was already persisted. Callers that branch on `reusedExisting`
    /// for telemetry should treat switch as its own operation rather than
    /// conflating it with an activate-reuse.
    func switchToManagedAssistant(
        assistantId: String
    ) async throws -> ManagedAssistantConnectionResult {
        guard multiAssistantEnabledProvider() else {
            throw ManagedAssistantConnectionCoordinatorError.multiAssistantNotEnabled
        }

        guard let connectionController else {
            throw ManagedAssistantConnectionCoordinatorError.missingConnectionController
        }

        guard let lockfileAssistant = LockfileAssistant.loadByName(
            assistantId,
            lockfilePath: lockfilePath
        ) else {
            throw ManagedAssistantConnectionCoordinatorError.assistantNotFound(assistantId)
        }

        // TODO: when `ManagedAssistantConnectionController.teardown()` or
        // `bringUp(for:)` gain `throws`, add a rollback path here — a
        // failing bringUp currently would leave us with the old SSE torn
        // down and `activeAssistantId` already flipped, with no recovery.
        await connectionController.teardown()

        LockfileAssistant.setActiveAssistantId(assistantId, lockfilePath: lockfilePath)
        AssistantFeatureFlagResolver.clearCachedFlags()

        updateAssistantTag(assistantId)

        await connectionController.bringUp(for: lockfileAssistant)

        return ManagedAssistantConnectionResult(
            assistant: PlatformAssistant(id: assistantId),
            reusedExisting: true
        )
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
