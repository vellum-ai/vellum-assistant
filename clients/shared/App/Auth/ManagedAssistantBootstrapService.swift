import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ManagedAssistantBootstrap")

/// Outcome of a managed assistant bootstrap attempt.
public enum ManagedBootstrapOutcome: Sendable {
    case reusedExisting(PlatformAssistant)
    case createdNew(PlatformAssistant)
}

/// Errors that can occur during managed assistant bootstrapping.
public enum ManagedBootstrapError: LocalizedError, Sendable {
    case authenticationRequired
    case networkError(String)
    case serverError(statusCode: Int, detail: String?)
    case hatchFailed(String)
    case unexpectedResponse(String)
    case multipleOrganizations
    case accessRevoked(String)

    public var errorDescription: String? {
        switch self {
        case .authenticationRequired:
            return "Sign in required to set up your assistant"
        case .networkError(let message):
            return "Network error: \(message)"
        case .serverError(let statusCode, let detail):
            return detail ?? "Server error (\(statusCode))"
        case .hatchFailed(let message):
            return "Failed to create assistant: \(message)"
        case .unexpectedResponse(let message):
            return "Unexpected response format: \(message)"
        case .multipleOrganizations:
            return "Multiple organizations found. Multi-org support is not yet available — please contact support."
        case .accessRevoked(let id):
            return "Access to assistant \(id) has been revoked. Please sign out and sign in again to set up a new assistant."
        }
    }
}

/// Orchestrates discovery or creation of a managed assistant on the platform.
///
/// The bootstrap flow:
/// 1. If a `connectedAssistantId` exists, fetch that specific assistant via GET /assistants/{id}/.
///    - 404 (deleted): clear the stale ID and fall through to step 2.
///    - 403 (access revoked): surface an `accessRevoked` error so the user knows.
/// 2. Call POST /assistants/hatch/ (idempotent — returns existing or creates new).
/// 3. Any other error is surfaced as a typed `ManagedBootstrapError`.
@MainActor
public final class ManagedAssistantBootstrapService {
    public static let shared = ManagedAssistantBootstrapService()

    private let authService: AuthService

    public init(authService: AuthService? = nil) {
        self.authService = authService ?? AuthService.shared
    }

    public func ensureManagedAssistant(
        name: String? = nil,
        description: String? = nil,
        anthropicApiKey: String? = nil
    ) async throws -> ManagedBootstrapOutcome {
        let organizationId = try await resolveOrganizationId()

        // If we already have a selected managed assistant, retrieve it directly.
        #if os(macOS)
        if let connectedId = LockfileAssistant.loadActiveAssistantId() {
            log.info("Found connectedAssistantId: \(connectedId, privacy: .public), retrieving directly")
            let result: PlatformAssistantResult
            do {
                result = try await authService.getAssistant(id: connectedId, organizationId: organizationId)
            } catch let error as PlatformAPIError {
                throw mapPlatformError(error)
            }

            switch result {
            case .found(let assistant):
                log.info("Retrieved connected assistant: \(assistant.id, privacy: .public)")
                return .reusedExisting(assistant)
            case .notFound:
                // Clear the stale ID and fall through to idempotent hatch.
                log.warning("Connected assistant \(connectedId, privacy: .public) not found — clearing stale ID and falling through to hatch")
                LockfileAssistant.setActiveAssistantId(nil)
            case .accessDenied:
                log.error("Access to connected assistant \(connectedId, privacy: .public) has been revoked")
                LockfileAssistant.setActiveAssistantId(nil)
                throw ManagedBootstrapError.accessRevoked(connectedId)
            }
        }
        #endif

        // No selected assistant (or stale one was cleared) — hatch is idempotent
        // and will return the existing assistant if one exists.
        log.info("No stored assistant ID — calling idempotent hatch")
        let hatchResult: HatchAssistantResult
        do {
            hatchResult = try await authService.hatchAssistant(
                organizationId: organizationId,
                name: name,
                description: description,
                anthropicApiKey: anthropicApiKey
            )
        } catch let error as PlatformAPIError {
            throw mapPlatformError(error)
        }

        switch hatchResult {
        case .reusedExisting(let assistant):
            log.info("Hatch returned existing assistant: \(assistant.id, privacy: .public)")
            return .reusedExisting(assistant)
        case .createdNew(let assistant):
            log.info("Hatch created new assistant: \(assistant.id, privacy: .public)")
            return .createdNew(assistant)
        }
    }

    /// Polls `GET /v1/assistants/{id}/` until the assistant's status indicates it is
    /// fully provisioned, or until the timeout elapses.
    ///
    /// If the platform response omits the `status` field (older API versions), the
    /// assistant is assumed ready immediately for backward compatibility.
    public func awaitAssistantProvisioned(assistantId: String, timeout: TimeInterval = 120) async throws {
        guard let organizationId = UserDefaults.standard.string(forKey: "connectedOrganizationId") else {
            log.warning("No persisted organization ID — skipping provisioning poll")
            return
        }

        let start = CFAbsoluteTimeGetCurrent()

        while CFAbsoluteTimeGetCurrent() - start < timeout {
            do {
                let result = try await authService.getAssistant(id: assistantId, organizationId: organizationId)
                switch result {
                case .found(let assistant):
                    guard let status = assistant.status else {
                        log.info("Assistant \(assistantId, privacy: .public) has no status field — treating as ready")
                        return
                    }
                    if status == "active" {
                        log.info("Assistant \(assistantId, privacy: .public) status is active")
                        return
                    }
                    let terminalFailureStatuses: Set<String> = ["failed", "error", "terminated"]
                    if terminalFailureStatuses.contains(status) {
                        log.error("Assistant \(assistantId, privacy: .public) reached terminal failure status: \(status, privacy: .public)")
                        throw ManagedBootstrapError.hatchFailed("Assistant provisioning \(status)")
                    }
                    log.info("Assistant \(assistantId, privacy: .public) status: \(status, privacy: .public) — continuing to poll")
                case .notFound:
                    log.warning("Assistant \(assistantId, privacy: .public) not found during provisioning poll")
                case .accessDenied:
                    throw ManagedBootstrapError.accessRevoked(assistantId)
                }
            } catch let error as ManagedBootstrapError {
                throw error
            } catch let error as PlatformAPIError {
                throw mapPlatformError(error)
            } catch {
                log.warning("Provisioning poll failed for \(assistantId, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }

            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
        }

        log.warning("Provisioning poll timed out for \(assistantId, privacy: .public) after \(timeout)s — proceeding to health check")
    }

    /// Resolve the organization ID, validating any persisted value against the
    /// user's actual org list to prevent stale cross-environment IDs.
    private func resolveOrganizationId() async throws -> String {
        do {
            let orgs = try await authService.getOrganizations()
            let persistedOrgId = UserDefaults.standard.string(forKey: "connectedOrganizationId")
            if let persistedOrgId, orgs.contains(where: { $0.id == persistedOrgId }) {
                log.info("Validated persisted organization: \(persistedOrgId, privacy: .public)")
                return persistedOrgId
            }
            if persistedOrgId != nil {
                log.warning("Persisted organization ID not found in user's orgs — re-resolving")
            }
            switch orgs.count {
            case 0:
                throw ManagedBootstrapError.serverError(statusCode: 0, detail: "No organizations found for this account")
            case 1:
                let orgId = orgs[0].id
                UserDefaults.standard.set(orgId, forKey: "connectedOrganizationId")
                log.info("Resolved organization: \(orgId, privacy: .public)")
                return orgId
            default:
                throw ManagedBootstrapError.multipleOrganizations
            }
        } catch let error as PlatformAPIError {
            throw mapPlatformError(error)
        }
    }

    private func mapPlatformError(_ error: PlatformAPIError) -> ManagedBootstrapError {
        switch error {
        case .authenticationRequired:
            return .authenticationRequired
        case .accessDenied(let detail):
            return .hatchFailed(detail)
        case .networkError(let message):
            return .networkError(message)
        case .serverError(let statusCode, let detail):
            return .serverError(statusCode: statusCode, detail: detail)
        case .invalidURL:
            return .serverError(statusCode: 0, detail: "Invalid URL configuration")
        case .decodingError(let message):
            return .unexpectedResponse(message)
        case .notFound:
            return .serverError(statusCode: 404, detail: "Not found")
        }
    }
}
