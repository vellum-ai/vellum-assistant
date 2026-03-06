import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "LocalAssistantBootstrap")

/// Outcome of a local assistant bootstrap attempt.
public enum LocalBootstrapOutcome: Sendable {
    case registeredWithExistingKey(assistantId: String)
    case registeredAndProvisioned(assistantId: String)
}

/// Errors that can occur during local assistant bootstrapping.
public enum LocalBootstrapError: LocalizedError, Sendable {
    case authenticationRequired
    case registrationFailed(String)
    case provisioningFailed(String)
    case daemonInjectionFailed
    case multipleOrganizations

    public var errorDescription: String? {
        switch self {
        case .authenticationRequired:
            return "Sign in required to register your assistant"
        case .registrationFailed(let message):
            return "Registration failed: \(message)"
        case .provisioningFailed(let message):
            return "API key provisioning failed: \(message)"
        case .daemonInjectionFailed:
            return "Failed to inject API key into the assistant"
        case .multipleOrganizations:
            return "Multiple organizations found. Multi-org support is not yet available — please contact support."
        }
    }
}

/// Bootstraps a locally hosted assistant with the platform:
/// 1. Calls ensure-registration to register (or re-confirm) the local assistant
/// 2. Checks whether an assistant API key is already stored locally
/// 3. If missing, calls reprovision-api-key and injects the key into the daemon
///
/// Does NOT reuse ManagedAssistantBootstrapService.
/// Does NOT write cloud = "vellum" into the lockfile.
@MainActor
public final class LocalAssistantBootstrapService {
    public static let shared = LocalAssistantBootstrapService()

    private let authService: AuthService

    /// The keychain/UserDefaults storage provider name for the provisioned credential.
    private static let credentialProvider = "vellum_assistant_credential"

    public init(authService: AuthService? = nil) {
        self.authService = authService ?? AuthService.shared
    }

    /// Bootstrap a local assistant with the platform.
    /// - Parameters:
    ///   - runtimeAssistantId: The local assistant's ID from the lockfile
    ///   - clientPlatform: e.g., "macos"
    ///   - daemonBaseURL: The local daemon's HTTP base URL (e.g., http://localhost:7821)
    ///   - daemonToken: The bearer token for authenticating with the local daemon
    public func bootstrap(
        runtimeAssistantId: String,
        clientPlatform: String = "macos",
        daemonBaseURL: String,
        daemonToken: String
    ) async throws -> LocalBootstrapOutcome {
        let installId = LocalInstallationIdStore.getOrCreate()

        // Resolve the user's organization ID — required for all platform API calls.
        let organizationId: String
        if let persistedOrgId = UserDefaults.standard.string(forKey: "connectedOrganizationId") {
            organizationId = persistedOrgId
            log.info("Using persisted organization: \(organizationId, privacy: .public)")
        } else {
            do {
                let orgs = try await authService.getOrganizations()
                switch orgs.count {
                case 0:
                    throw LocalBootstrapError.registrationFailed("No organizations found for this account")
                case 1:
                    organizationId = orgs[0].id
                default:
                    throw LocalBootstrapError.multipleOrganizations
                }
                UserDefaults.standard.set(organizationId, forKey: "connectedOrganizationId")
                log.info("Resolved organization: \(organizationId, privacy: .public)")
            } catch let error as LocalBootstrapError {
                throw error
            } catch let error as PlatformAPIError {
                throw mapPlatformError(error)
            } catch {
                throw LocalBootstrapError.registrationFailed(error.localizedDescription)
            }
        }

        // Step 1: Ensure registration (idempotent)
        let registration: EnsureSelfHostedLocalRegistrationResponse
        do {
            registration = try await authService.ensureSelfHostedLocalRegistration(
                organizationId: organizationId,
                clientInstallationId: installId,
                runtimeAssistantId: runtimeAssistantId,
                clientPlatform: clientPlatform
            )
        } catch let error as PlatformAPIError {
            throw mapPlatformError(error)
        } catch {
            throw LocalBootstrapError.registrationFailed(error.localizedDescription)
        }

        let platformAssistantId = registration.assistant.id
        log.info("Registered local assistant: \(platformAssistantId, privacy: .public)")

        // Step 2: Check if we already have the key stored locally
        if let existingKey = APIKeyManager.shared.getAPIKey(provider: Self.credentialProvider), !existingKey.isEmpty {
            // Key exists locally — re-sync to daemon (it may have restarted)
            try await injectKeyIntoDaemon(key: existingKey, daemonBaseURL: daemonBaseURL, daemonToken: daemonToken)
            log.info("Re-synced existing API key to daemon")
            return .registeredWithExistingKey(assistantId: platformAssistantId)
        }

        // Step 3: No key stored — reprovision
        let provisionResponse: ReprovisionSelfHostedLocalApiKeyResponse
        do {
            provisionResponse = try await authService.reprovisionSelfHostedLocalAssistantApiKey(
                organizationId: organizationId,
                clientInstallationId: installId,
                runtimeAssistantId: runtimeAssistantId,
                clientPlatform: clientPlatform
            )
        } catch let error as PlatformAPIError {
            throw mapPlatformError(error)
        } catch {
            throw LocalBootstrapError.provisioningFailed(error.localizedDescription)
        }

        let rawKey = provisionResponse.provisioning.assistantApiKey
        log.info("Provisioned new API key for assistant: \(platformAssistantId, privacy: .public)")

        // Step 4: Store locally for future sign-ins
        _ = APIKeyManager.shared.setAPIKey(rawKey, provider: Self.credentialProvider)

        // Step 5: Inject into daemon
        try await injectKeyIntoDaemon(key: rawKey, daemonBaseURL: daemonBaseURL, daemonToken: daemonToken)

        return .registeredAndProvisioned(assistantId: platformAssistantId)
    }

    /// Inject the assistant API key into the daemon's secret store.
    private func injectKeyIntoDaemon(key: String, daemonBaseURL: String, daemonToken: String) async throws {
        guard let url = URL(string: "\(daemonBaseURL)/v1/secrets") else {
            throw LocalBootstrapError.daemonInjectionFailed
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(daemonToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10

        let body: [String: String] = [
            "type": "credential",
            "name": "vellum:assistant_api_key",
            "value": key
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw LocalBootstrapError.daemonInjectionFailed
        }
    }

    private func mapPlatformError(_ error: PlatformAPIError) -> LocalBootstrapError {
        switch error {
        case .authenticationRequired:
            return .authenticationRequired
        case .networkError(let message):
            return .registrationFailed(message)
        case .serverError(_, let detail):
            return .registrationFailed(detail ?? error.localizedDescription)
        case .invalidURL:
            return .registrationFailed("Invalid URL configuration")
        case .decodingError(let message):
            return .registrationFailed("Unexpected response: \(message)")
        }
    }
}
