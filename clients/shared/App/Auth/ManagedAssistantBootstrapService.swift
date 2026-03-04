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
        }
    }
}

/// Orchestrates discovery or creation of a managed assistant on the platform.
///
/// The bootstrap flow:
/// 1. Try to fetch the current user's managed assistant.
/// 2. If one exists (200), return it as `.reusedExisting`.
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
        // Resolve the user's organization ID first — required for all platform API calls.
        let organizationId: String
        do {
            let orgs = try await authService.getOrganizations()
            guard let firstOrg = orgs.first else {
                throw ManagedBootstrapError.serverError(statusCode: 0, detail: "No organizations found for this account")
            }
            organizationId = firstOrg.id
            log.info("Resolved organization: \(organizationId, privacy: .public)")
        } catch let error as PlatformAPIError {
            throw mapPlatformError(error)
        }

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
