import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ManagedAssistantBootstrap")

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
/// 2. Fall back to GET /assistants/current/ to discover the user's assistant.
/// 3. If none exists (404), create one via hatch and return `.createdNew`.
/// 4. Any other error is surfaced as a typed `ManagedBootstrapError`.
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
        if let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId") {
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
                // Clear the stale ID and fall through to current/ + hatch
                // so the user doesn't have to manually retry.
                log.warning("Connected assistant \(connectedId, privacy: .public) not found — clearing stale ID and falling through to discovery")
                UserDefaults.standard.removeObject(forKey: "connectedAssistantId")
            case .accessDenied:
                log.error("Access to connected assistant \(connectedId, privacy: .public) has been revoked")
                UserDefaults.standard.removeObject(forKey: "connectedAssistantId")
                throw ManagedBootstrapError.accessRevoked(connectedId)
            }
        }

        // No selected assistant (or stale one was cleared) — discover via current/ or hatch a new one.
        log.info("Falling back to current/ discovery")
        let currentResult: PlatformAssistantResult
        do {
            currentResult = try await authService.getCurrentAssistant(organizationId: organizationId)
        } catch let error as PlatformAPIError {
            throw mapPlatformError(error)
        }

        switch currentResult {
        case .found(let assistant):
            log.info("Found existing managed assistant: \(assistant.id, privacy: .public)")
            return .reusedExisting(assistant)

        case .accessDenied:
            throw ManagedBootstrapError.authenticationRequired

        case .notFound:
            log.info("No managed assistant found, hatching a new one")
            let newAssistant: PlatformAssistant
            do {
                newAssistant = try await authService.hatchAssistant(
                    organizationId: organizationId,
                    name: name,
                    description: description,
                    anthropicApiKey: anthropicApiKey
                )
            } catch let error as PlatformAPIError {
                throw mapPlatformError(error)
            }
            log.info("Created new managed assistant: \(newAssistant.id, privacy: .public)")
            return .createdNew(newAssistant)
        }
    }

    /// Discovers an already-associated managed assistant for the signed-in
    /// account without creating a new one when none exists.
    public func discoverManagedAssistant() async throws -> PlatformAssistant? {
        let organizationId = try await resolveOrganizationId()

        log.info("Checking for an existing managed assistant via current/ discovery")
        let currentResult: PlatformAssistantResult
        do {
            currentResult = try await authService.getCurrentAssistant(organizationId: organizationId)
        } catch let error as PlatformAPIError {
            throw mapPlatformError(error)
        }

        switch currentResult {
        case .found(let assistant):
            log.info("Discovered existing managed assistant: \(assistant.id, privacy: .public)")
            return assistant
        case .notFound:
            log.info("No existing managed assistant found for the signed-in account")
            return nil
        case .accessDenied:
            throw ManagedBootstrapError.authenticationRequired
        }
    }

    /// Resolve the organization ID, preferring the persisted value.
    private func resolveOrganizationId() async throws -> String {
        if let persistedOrgId = UserDefaults.standard.string(forKey: "connectedOrganizationId") {
            log.info("Using persisted organization: \(persistedOrgId, privacy: .public)")
            return persistedOrgId
        }

        do {
            let orgs = try await authService.getOrganizations()
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
        case .networkError(let message):
            return .networkError(message)
        case .serverError(let statusCode, let detail):
            return .serverError(statusCode: statusCode, detail: detail)
        case .invalidURL:
            return .serverError(statusCode: 0, detail: "Invalid URL configuration")
        case .decodingError(let message):
            return .unexpectedResponse(message)
        }
    }
}
