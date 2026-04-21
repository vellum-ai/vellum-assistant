#if canImport(UIKit)
import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ManagedAssistantIOSReconciler")

/// Minimal protocol over `AuthService` for the active-assistant lookup step.
///
/// Keeps the reconciler unit-testable without touching the real network. The
/// existing `ManagedAssistantBootstrapAuthServicing` protocol covers hatch /
/// list / resolveOrganizationId but not `getActiveAssistant`, so this is the
/// only additional capability the reconciler needs.
@MainActor
protocol ManagedAssistantActiveAssistantLookup: AnyObject {
    func resolveOrganizationId() async throws -> String
    func getActiveAssistant(organizationId: String) async throws -> PlatformAssistantResult
}

extension AuthService: ManagedAssistantActiveAssistantLookup {}

/// Minimal protocol over `ManagedAssistantBootstrapService.ensureManagedAssistant(...)`.
@MainActor
protocol ManagedAssistantBootstrapping: AnyObject {
    func ensureManagedAssistant(
        name: String?,
        description: String?,
        anthropicApiKey: String?
    ) async throws -> ManagedBootstrapOutcome
}

extension ManagedAssistantBootstrapService: ManagedAssistantBootstrapping {}

/// Persists the selected assistant's managed-connection identifiers and rebuilds
/// the daemon client so `GatewayHTTPClient.resolveConnection()` can produce a
/// `ConnectionInfo` for outbound requests.
///
/// Used by both first-launch onboarding (`OnboardingView`) and post-authentication
/// reconciliation (`AuthManager.postAuthenticationHook`), so logout→re-login
/// restores the same state the first-run flow establishes.
///
/// On macOS the equivalent responsibility lives in `ManagedAssistantConnectionCoordinator`
/// + `LockfileAssistant`. This type exists so iOS has a single place where the
/// UserDefaults persistence contract and the `clientProvider.rebuildClient()`
/// trigger live.
@MainActor
final class ManagedAssistantIOSReconciler {
    private let authLookup: ManagedAssistantActiveAssistantLookup
    private let bootstrap: ManagedAssistantBootstrapping
    private let defaults: UserDefaults
    private let platformBaseURL: () -> String
    private let rebuildClient: @MainActor () -> Void

    init(
        authLookup: ManagedAssistantActiveAssistantLookup = AuthService.shared,
        bootstrap: ManagedAssistantBootstrapping = ManagedAssistantBootstrapService.shared,
        defaults: UserDefaults = .standard,
        platformBaseURL: @autoclosure @escaping () -> String = VellumEnvironment.resolvedPlatformURL,
        rebuildClient: @escaping @MainActor () -> Void
    ) {
        self.authLookup = authLookup
        self.bootstrap = bootstrap
        self.defaults = defaults
        self.platformBaseURL = platformBaseURL
        self.rebuildClient = rebuildClient
    }

    /// Ensures the iOS managed-connection identifiers are present in UserDefaults
    /// and the daemon client is rebuilt against them.
    ///
    /// - Parameter forceRefresh: When `false` (default), skips the network round-trip
    ///   if `managed_assistant_id` is already persisted. When `true`, re-discovers
    ///   the assistant regardless — used from onboarding where the user just signed
    ///   in and there is no prior persisted state to trust.
    /// - Returns: The assistant whose identifiers are persisted, or `nil` when
    ///   reconciliation short-circuited because identifiers were already present.
    /// - Throws: Any error from the underlying `AuthService` / bootstrap calls.
    @discardableResult
    func reconcile(forceRefresh: Bool = false) async throws -> PlatformAssistant? {
        if !forceRefresh,
           let existingId = defaults.string(forKey: UserDefaultsKeys.managedAssistantId),
           !existingId.isEmpty,
           let existingURL = defaults.string(forKey: UserDefaultsKeys.managedPlatformBaseURL),
           !existingURL.isEmpty {
            log.info("Managed connection identifiers already persisted for \(existingId, privacy: .public) — skipping reconcile")
            return nil
        }

        let assistant = try await resolveAssistant()
        persist(assistant)
        rebuildClient()
        return assistant
    }

    private func resolveAssistant() async throws -> PlatformAssistant {
        let orgId = try await authLookup.resolveOrganizationId()
        let activeResult = try await authLookup.getActiveAssistant(organizationId: orgId)
        if case .found(let existing) = activeResult {
            log.info("Resolved active managed assistant \(existing.id, privacy: .public)")
            return existing
        }

        log.info("No active managed assistant — running idempotent bootstrap")
        let outcome = try await bootstrap.ensureManagedAssistant(
            name: nil,
            description: nil,
            anthropicApiKey: nil
        )
        switch outcome {
        case .reusedExisting(let assistant):
            log.info("Bootstrap reused existing assistant \(assistant.id, privacy: .public)")
            return assistant
        case .createdNew(let assistant):
            log.info("Bootstrap created new assistant \(assistant.id, privacy: .public)")
            return assistant
        }
    }

    private func persist(_ assistant: PlatformAssistant) {
        defaults.set(assistant.id, forKey: UserDefaultsKeys.managedAssistantId)
        defaults.set(platformBaseURL(), forKey: UserDefaultsKeys.managedPlatformBaseURL)
    }
}
#endif
