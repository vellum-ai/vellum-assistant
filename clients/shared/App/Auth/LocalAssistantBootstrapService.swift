import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "LocalAssistantBootstrap")

/// Platform-agnostic credential storage abstraction.
/// On macOS, callers should supply a Keychain-backed implementation.
public protocol CredentialStorage: Sendable {
    func get(account: String) -> String?
    func set(account: String, value: String) -> Bool
    func delete(account: String) -> Bool
}

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

    private let authService: AuthService
    private let credentialStorage: CredentialStorage?

    /// Returns the credential account name for the provisioned credential, scoped to the assistant.
    public static func credentialAccount(for runtimeAssistantId: String) -> String {
        "vellum_assistant_credential_\(runtimeAssistantId)"
    }

    public init(authService: AuthService? = nil, credentialStorage: CredentialStorage? = nil) {
        self.authService = authService ?? AuthService.shared
        self.credentialStorage = credentialStorage
    }

    /// Bootstrap a local assistant with the platform.
    /// - Parameters:
    ///   - runtimeAssistantId: The local assistant's ID from the lockfile
    ///   - clientPlatform: e.g., "macos"
    public func bootstrap(
        runtimeAssistantId: String,
        clientPlatform: String = "macos"
    ) async throws -> LocalBootstrapOutcome {
        let installId = DeviceIdStore.getOrCreate()

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
                throw mapPlatformError(error, context: .registration)
            } catch {
                throw LocalBootstrapError.registrationFailed(error.localizedDescription)
            }
        }

        // Step 1: Ensure registration (idempotent)
        var platformAssistantId: String?
        do {
            let registration = try await authService.ensureSelfHostedLocalRegistration(
                organizationId: organizationId,
                clientInstallationId: installId,
                runtimeAssistantId: runtimeAssistantId,
                clientPlatform: clientPlatform
            )
            platformAssistantId = registration.assistant.id
            log.info("Registered local assistant: \(registration.assistant.id, privacy: .public)")

            // Persist the platform assistant ID mapping so other services can resolve it.
            if let storage = credentialStorage {
                let userId = try? await resolveUserId()
                if let uid = userId {
                    let persisted = PlatformAssistantIdResolver.persist(
                        platformAssistantId: registration.assistant.id,
                        runtimeAssistantId: runtimeAssistantId,
                        organizationId: organizationId,
                        userId: uid,
                        credentialStorage: storage
                    )
                    if persisted {
                        log.info("Persisted platform assistant ID mapping for runtime assistant: \(runtimeAssistantId, privacy: .public)")
                    } else {
                        log.warning("Failed to persist platform assistant ID mapping for runtime assistant: \(runtimeAssistantId, privacy: .public)")
                    }
                } else {
                    log.warning("Could not resolve user ID — platform assistant ID mapping not persisted")
                }
            }

            // Cache the API key from the registration response so Step 2 can re-sync
            // without an unnecessary reprovision round-trip.
            if let rawKey = registration.assistantApiKey, !rawKey.isEmpty {
                let credentialAccount = Self.credentialAccount(for: runtimeAssistantId)
                _ = credentialStorage?.set(account: credentialAccount, value: rawKey)
                log.info("Cached API key from ensure-registration response")
            }
        } catch let error as PlatformAPIError {
            if case .serverError(let statusCode, _) = error, statusCode == 409 {
                // Try to resolve platform assistant ID from cache for key re-sync
                if let storage = credentialStorage,
                   let uid = try? await resolveUserId(),
                   let cachedId = PlatformAssistantIdResolver.resolve(
                       lockfileAssistantId: runtimeAssistantId,
                       isManaged: false,
                       organizationId: organizationId,
                       userId: uid,
                       credentialStorage: storage
                   ) {
                    platformAssistantId = cachedId
                    log.info("Registration returned 409 — resolved platform assistant ID from cache: \(cachedId, privacy: .public)")
                } else {
                    log.info("Registration returned 409 — no cached platform ID, will resolve from reprovision")
                    // platformAssistantId stays nil — reprovision will provide it
                }
            } else {
                throw mapPlatformError(error, context: .registration)
            }
        } catch {
            throw LocalBootstrapError.registrationFailed(error.localizedDescription)
        }

        let credentialAccount = Self.credentialAccount(for: runtimeAssistantId)

        // Step 2: Check if we already have the key stored locally (only when we have the platform ID)
        var existingKeyInjected = false
        if platformAssistantId != nil,
           let existingKey = credentialStorage?.get(account: credentialAccount), !existingKey.isEmpty {
            do {
                try await injectKeyIntoDaemon(key: existingKey)
                log.info("Re-synced existing API key to daemon")
                existingKeyInjected = true
            } catch {
                log.warning("Failed to inject existing key into daemon, will reprovision: \(error.localizedDescription)")
                // Fall through to Step 3 — key may be stale
            }
        }

        if existingKeyInjected, let platformId = platformAssistantId {
            try? await injectPlatformAssistantIdIntoDaemon(id: platformId)
            do {
                try await injectPlatformBaseUrlIntoDaemon(url: authService.baseURL)
            } catch {
                log.error("Failed to inject platform base URL into daemon on existing-key path: \(error.localizedDescription)")
                throw LocalBootstrapError.daemonInjectionFailed
            }
            return .registeredWithExistingKey(assistantId: platformId)
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
            throw mapPlatformError(error, context: .provisioning)
        } catch {
            throw LocalBootstrapError.provisioningFailed(error.localizedDescription)
        }

        // If platformAssistantId was not resolved from Step 1 (e.g. 409 path),
        // resolve it from the reprovision response which includes the assistant record.
        if platformAssistantId == nil {
            platformAssistantId = provisionResponse.assistant.id
            log.info("Resolved platform assistant ID from reprovision: \(provisionResponse.assistant.id, privacy: .public)")

            // Persist the mapping now that we have it
            if let storage = credentialStorage {
                let userId = try? await resolveUserId()
                if let uid = userId {
                    PlatformAssistantIdResolver.persist(
                        platformAssistantId: provisionResponse.assistant.id,
                        runtimeAssistantId: runtimeAssistantId,
                        organizationId: organizationId,
                        userId: uid,
                        credentialStorage: storage
                    )
                }
            }
        }

        guard let resolvedPlatformId = platformAssistantId else {
            throw LocalBootstrapError.registrationFailed("Failed to resolve platform assistant ID")
        }

        let rawKey = provisionResponse.provisioning.assistantApiKey
        log.info("Provisioned new API key for assistant: \(resolvedPlatformId, privacy: .public)")

        // Step 4: Store locally for future sign-ins
        _ = credentialStorage?.set(account: credentialAccount, value: rawKey)

        // Step 5: Inject into daemon
        try await injectKeyIntoDaemon(key: rawKey)
        if (try? await injectPlatformAssistantIdIntoDaemon(id: resolvedPlatformId)) == nil {
            log.warning("Failed to inject platform assistant ID into daemon on provision path; the TS env-var fallback will be used")
        }
        do {
            try await injectPlatformBaseUrlIntoDaemon(url: authService.baseURL)
        } catch {
            log.error("Failed to inject platform base URL into daemon on provision path: \(error.localizedDescription)")
            throw LocalBootstrapError.daemonInjectionFailed
        }

        return .registeredAndProvisioned(assistantId: resolvedPlatformId)
    }

    /// Clear the stored credential and re-run bootstrap to obtain a fresh key.
    /// Call this when a 401 indicates the cached key has been revoked.
    public func reprovision(
        runtimeAssistantId: String,
        clientPlatform: String = "macos"
    ) async throws -> LocalBootstrapOutcome {
        let account = Self.credentialAccount(for: runtimeAssistantId)
        _ = credentialStorage?.delete(account: account)

        return try await bootstrap(
            runtimeAssistantId: runtimeAssistantId,
            clientPlatform: clientPlatform
        )
    }

    /// Inject the assistant API key into the daemon's secret store via the gateway.
    private func injectKeyIntoDaemon(key: String) async throws {
        let response = try await GatewayHTTPClient.post(
            path: "secrets",
            json: ["type": "credential", "name": "vellum:assistant_api_key", "value": key],
            timeout: 10
        )
        guard response.isSuccess else {
            throw LocalBootstrapError.daemonInjectionFailed
        }
    }

    /// Inject the platform base URL into the daemon's secret store via the gateway.
    private func injectPlatformBaseUrlIntoDaemon(url: String) async throws {
        let response = try await GatewayHTTPClient.post(
            path: "secrets",
            json: ["type": "credential", "name": "vellum:platform_base_url", "value": url],
            timeout: 10
        )
        guard response.isSuccess else {
            throw LocalBootstrapError.daemonInjectionFailed
        }
    }

    /// Inject the platform assistant ID into the daemon's secret store via the gateway.
    private func injectPlatformAssistantIdIntoDaemon(id: String) async throws {
        let response = try await GatewayHTTPClient.post(
            path: "secrets",
            json: ["type": "credential", "name": "vellum:platform_assistant_id", "value": id],
            timeout: 10
        )
        guard response.isSuccess else {
            throw LocalBootstrapError.daemonInjectionFailed
        }
    }

    /// Clears all managed proxy credentials from the daemon's secret store
    /// by issuing `DELETE /v1/secrets` for each vellum-namespaced credential.
    ///
    /// Uses a direct HTTP call to the daemon (not GatewayHTTPClient) because
    /// this is called during logout teardown when gateway routing may no
    /// longer be available.
    ///
    /// Returns `true` if all credentials were successfully cleared (or didn't exist).
    @discardableResult
    public static func clearDaemonCredentials(
        daemonBaseURL: String,
        daemonToken: String
    ) async -> Bool {
        let credentialNames = [
            "vellum:assistant_api_key",
            "vellum:platform_base_url",
            "vellum:platform_assistant_id",
        ]
        var allCleared = true
        for name in credentialNames {
            guard let url = URL(string: "\(daemonBaseURL)/v1/secrets") else {
                allCleared = false
                continue
            }
            var request = URLRequest(url: url)
            request.httpMethod = "DELETE"
            request.timeoutInterval = 5
            request.setValue("Bearer \(daemonToken)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let body: [String: String] = ["type": "credential", "name": name]
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            do {
                let (_, response) = try await URLSession.shared.data(for: request)
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
                if statusCode == 200 || statusCode == 404 {
                    log.info("Cleared daemon credential: \(name, privacy: .public) (status \(statusCode))")
                } else {
                    log.warning("Failed to clear daemon credential: \(name, privacy: .public) (status \(statusCode))")
                    allCleared = false
                }
            } catch {
                log.warning("Failed to clear daemon credential: \(name, privacy: .public) — \(error.localizedDescription)")
                allCleared = false
            }
        }
        if allCleared {
            log.info("All managed proxy credentials cleared from daemon")
        } else {
            log.warning("Some managed proxy credentials could not be cleared from daemon")
        }
        return allCleared
    }

    /// Resolves the current user ID from the auth session.
    private func resolveUserId() async throws -> String? {
        let session = try await authService.getSession()
        return session.data?.user?.id
    }

    private enum ErrorContext {
        case registration
        case provisioning
    }

    private func mapPlatformError(_ error: Error, context: ErrorContext) -> LocalBootstrapError {
        if let platformErr = error as? PlatformAPIError {
            switch platformErr {
            case .authenticationRequired:
                return .authenticationRequired
            default:
                switch context {
                case .registration:
                    return .registrationFailed(platformErr.localizedDescription)
                case .provisioning:
                    return .provisioningFailed(platformErr.localizedDescription)
                }
            }
        }
        switch context {
        case .registration:
            return .registrationFailed(error.localizedDescription)
        case .provisioning:
            return .provisioningFailed(error.localizedDescription)
        }
    }
}
