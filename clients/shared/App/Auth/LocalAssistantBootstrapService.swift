import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "LocalAssistantBootstrap")

/// Platform-agnostic credential storage abstraction.
/// On macOS, callers supply a file-based implementation (FileCredentialStorage).
public protocol CredentialStorage: Sendable {
    func get(account: String) -> String?
    func set(account: String, value: String) -> Bool
    func delete(account: String) -> Bool
}

/// Errors that can occur during local assistant bootstrapping.
public enum LocalBootstrapError: LocalizedError, Sendable {
    case authenticationRequired
    case registrationFailed(String)
    case provisioningFailed(String)
    case assistantInjectionFailed
    case multipleOrganizations
    /// The user already has a different local assistant registered with the
    /// platform. Carries the existing assistant so the UI can offer to retire
    /// it and retry. Also carries the organization ID needed for the retire
    /// call so callers don't have to re-resolve it.
    case existingRegistrationConflict(existing: PlatformAssistant, organizationId: String)

    public var errorDescription: String? {
        switch self {
        case .authenticationRequired:
            return "Sign in required to register your assistant"
        case .registrationFailed(let message):
            return "Registration failed: \(message)"
        case .provisioningFailed(let message):
            return "API key provisioning failed: \(message)"
        case .assistantInjectionFailed:
            return "Failed to inject API key into the assistant"
        case .multipleOrganizations:
            return "Multiple organizations found. Multi-org support is not yet available — please contact support."
        case .existingRegistrationConflict(let existing, _):
            let label = existing.name ?? existing.id
            return "Another local assistant (\(label)) is already registered to your account."
        }
    }
}

/// Bootstraps a locally hosted assistant with the platform.
///
/// 1. Calls ensure-registration — on first call returns a fresh API key;
///    on subsequent calls returns `assistant_api_key: null` (the raw key
///    is hashed server-side and can't be recovered).
/// 2. If a new key was returned, persists it locally and injects into the assistant.
/// 3. If no key was returned, uses the locally persisted key.
/// 4. If the persisted key is missing, calls reprovision-api-key to rotate
///    and get a fresh one.
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

    /// Deletes the locally cached bootstrap credential for a runtime assistant.
    ///
    /// Centralises the "what counts as this assistant's credentials" knowledge
    /// so callers don't need to know the account naming scheme.
    @discardableResult
    public static func clearBootstrapCredential(
        runtimeAssistantId: String,
        credentialStorage: CredentialStorage
    ) -> Bool {
        let account = credentialAccount(for: runtimeAssistantId)
        return credentialStorage.delete(account: account)
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
        clientPlatform: String = "macos",
        assistantVersion: String? = nil
    ) async throws -> String {
        let installId = DeviceIdStore.getOrCreate()

        // Resolve the user's organization ID — required for all platform API calls.
        // Always fetch the org list to validate any persisted ID, since the persisted
        // value may belong to a different environment (e.g. dev vs prod).
        let organizationId: String
        do {
            let orgs = try await authService.getOrganizations()
            let persistedOrgId = UserDefaults.standard.string(forKey: AuthService.connectedOrganizationIdKey)
            if let persistedOrgId, orgs.contains(where: { $0.id == persistedOrgId }) {
                organizationId = persistedOrgId
                log.info("Validated persisted organization: \(organizationId, privacy: .public)")
            } else {
                if persistedOrgId != nil {
                    log.warning("Persisted organization ID not found in user's orgs — re-resolving")
                }
                switch orgs.count {
                case 0:
                    throw LocalBootstrapError.registrationFailed("No organizations found for this account")
                case 1:
                    organizationId = orgs[0].id
                default:
                    throw LocalBootstrapError.multipleOrganizations
                }
                UserDefaults.standard.set(organizationId, forKey: AuthService.connectedOrganizationIdKey)
                log.info("Resolved organization: \(organizationId, privacy: .public)")
            }
        } catch let error as LocalBootstrapError {
            throw error
        } catch let error as PlatformAPIError {
            throw mapPlatformError(error, context: .registration)
        } catch {
            throw LocalBootstrapError.registrationFailed(error.localizedDescription)
        }

        // Step 1: Ensure registration (idempotent, never 409s)
        let registration: EnsureSelfHostedLocalRegistrationResponse
        do {
            registration = try await authService.ensureSelfHostedLocalRegistration(
                organizationId: organizationId,
                clientInstallationId: installId,
                runtimeAssistantId: runtimeAssistantId,
                clientPlatform: clientPlatform,
                assistantVersion: assistantVersion
            )
        } catch let error as PlatformAPIError {
            // Non-Vellum users are capped at one local assistant; the platform
            // returns 400 with code=single_local_assistant_limit when a
            // different runtime tries to register. Gate on the code (not just
            // the 400 status) so unrelated bad-request responses fall through
            // to the generic registration-failed path.
            if case .serverError(400, let body) = error,
               Self.isSingleLocalAssistantLimitError(body),
               let existing = try? await firstExistingLocalAssistant(organizationId: organizationId) {
                throw LocalBootstrapError.existingRegistrationConflict(
                    existing: existing,
                    organizationId: organizationId
                )
            }
            throw mapPlatformError(error, context: .registration)
        } catch {
            throw LocalBootstrapError.registrationFailed(error.localizedDescription)
        }

        let platformAssistantId = registration.assistant.id
        log.info("Registered local assistant: \(platformAssistantId, privacy: .public)")

        // Persist the platform assistant ID mapping so other services can resolve it.
        if let storage = credentialStorage {
            if let uid = try? await resolveUserId() {
                let persisted = PlatformAssistantIdResolver.persist(
                    platformAssistantId: platformAssistantId,
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

        // Step 2: Resolve the API key to inject.
        // - If ensure-registration returned a new key (first call), persist and use it.
        // - Otherwise, use the locally persisted key.
        // - If no persisted key exists, call reprovision to rotate and get a fresh one.
        let credentialAccount = Self.credentialAccount(for: runtimeAssistantId)
        let apiKey: String

        if let newKey = registration.assistantApiKey, !newKey.isEmpty {
            // Fresh key from first registration
            apiKey = newKey
            _ = credentialStorage?.set(account: credentialAccount, value: newKey)
            log.info("Received and cached new API key from ensure-registration")
        } else if let cachedKey = credentialStorage?.get(account: credentialAccount), !cachedKey.isEmpty {
            // Existing key persisted locally
            apiKey = cachedKey
            log.info("Using locally persisted API key")
        } else {
            // No key available — reprovision
            log.info("No API key available locally — calling reprovision")
            let provisionResponse: ReprovisionSelfHostedLocalApiKeyResponse
            do {
                provisionResponse = try await authService.reprovisionSelfHostedLocalAssistantApiKey(
                    organizationId: organizationId,
                    clientInstallationId: installId,
                    runtimeAssistantId: runtimeAssistantId,
                    clientPlatform: clientPlatform,
                    assistantVersion: assistantVersion
                )
            } catch let error as PlatformAPIError {
                throw mapPlatformError(error, context: .provisioning)
            } catch {
                throw LocalBootstrapError.provisioningFailed(error.localizedDescription)
            }
            apiKey = provisionResponse.provisioning.assistantApiKey
            _ = credentialStorage?.set(account: credentialAccount, value: apiKey)
            log.info("Provisioned and cached new API key via reprovision")
        }

        // Step 3: Inject credentials into assistant
        try await injectKeyIntoAssistant(key: apiKey)
        try? await injectPlatformAssistantIdIntoAssistant(id: platformAssistantId)
        do {
            try await injectPlatformBaseUrlIntoAssistant(url: VellumEnvironment.resolvedPlatformURL)
        } catch {
            log.error("Failed to inject platform base URL into assistant: \(error.localizedDescription)")
            throw LocalBootstrapError.assistantInjectionFailed
        }
        try? await injectPlatformOrganizationIdIntoAssistant(id: organizationId)
        if let uid = try? await resolveUserId() {
            try? await injectPlatformUserIdIntoAssistant(id: uid)
        }
        if let secret = registration.webhookSecret, !secret.isEmpty {
            try? await injectWebhookSecretIntoAssistant(secret: secret)
        }

        return platformAssistantId
    }

    /// Clear the stored credential and re-run bootstrap to obtain a fresh key.
    /// Call this when a 401/403 indicates the cached key has been revoked.
    public func reprovision(
        runtimeAssistantId: String,
        clientPlatform: String = "macos",
        assistantVersion: String? = nil
    ) async throws -> String {
        let account = Self.credentialAccount(for: runtimeAssistantId)
        _ = credentialStorage?.delete(account: account)

        return try await bootstrap(
            runtimeAssistantId: runtimeAssistantId,
            clientPlatform: clientPlatform,
            assistantVersion: assistantVersion
        )
    }

    /// Inject the assistant API key into the assistant's secret store via the gateway.
    private func injectKeyIntoAssistant(key: String) async throws {
        let response = try await GatewayHTTPClient.post(
            path: "secrets",
            json: ["type": "credential", "name": "vellum:assistant_api_key", "value": key],
            timeout: 10
        )
        guard response.isSuccess else {
            log.error("Failed to inject API key into assistant: status=\(response.statusCode, privacy: .public) body=\(String(data: response.data, encoding: .utf8) ?? "<non-utf8>", privacy: .public)")
            throw LocalBootstrapError.assistantInjectionFailed
        }
    }

    /// Inject the platform base URL into the assistant's secret store via the gateway.
    private func injectPlatformBaseUrlIntoAssistant(url: String) async throws {
        let response = try await GatewayHTTPClient.post(
            path: "secrets",
            json: ["type": "credential", "name": "vellum:platform_base_url", "value": url],
            timeout: 10
        )
        guard response.isSuccess else {
            throw LocalBootstrapError.assistantInjectionFailed
        }
    }

    /// Inject the platform assistant ID into the assistant's secret store via the gateway.
    private func injectPlatformAssistantIdIntoAssistant(id: String) async throws {
        let response = try await GatewayHTTPClient.post(
            path: "secrets",
            json: ["type": "credential", "name": "vellum:platform_assistant_id", "value": id],
            timeout: 10
        )
        guard response.isSuccess else {
            throw LocalBootstrapError.assistantInjectionFailed
        }
    }

    /// Inject the platform organization ID into the assistant's secret store via the gateway.
    private func injectPlatformOrganizationIdIntoAssistant(id: String) async throws {
        let response = try await GatewayHTTPClient.post(
            path: "secrets",
            json: ["type": "credential", "name": "vellum:platform_organization_id", "value": id],
            timeout: 10
        )
        guard response.isSuccess else {
            throw LocalBootstrapError.assistantInjectionFailed
        }
    }

    /// Inject the platform user ID into the assistant's secret store via the gateway.
    private func injectPlatformUserIdIntoAssistant(id: String) async throws {
        let response = try await GatewayHTTPClient.post(
            path: "secrets",
            json: ["type": "credential", "name": "vellum:platform_user_id", "value": id],
            timeout: 10
        )
        guard response.isSuccess else {
            throw LocalBootstrapError.assistantInjectionFailed
        }
    }

    /// Inject the webhook secret into the assistant's secret store via the gateway.
    private func injectWebhookSecretIntoAssistant(secret: String) async throws {
        let response = try await GatewayHTTPClient.post(
            path: "secrets",
            json: ["type": "credential", "name": "vellum:webhook_secret", "value": secret],
            timeout: 10
        )
        guard response.isSuccess else {
            throw LocalBootstrapError.assistantInjectionFailed
        }
    }

    /// Clears platform identity credentials and the assistant API key from
    /// the assistant's secret store by issuing `DELETE /v1/secrets` for each
    /// vellum-namespaced credential.
    ///
    /// Returns `true` if all credentials were successfully cleared (or didn't exist).
    @discardableResult
    public static func clearAssistantCredentials() async -> Bool {
        let credentialNames = [
            "vellum:assistant_api_key",
            "vellum:platform_assistant_id",
            "vellum:platform_base_url",
            "vellum:platform_organization_id",
            "vellum:platform_user_id",
            "vellum:webhook_secret",
        ]
        var allCleared = true
        for name in credentialNames {
            let body: [String: String] = ["type": "credential", "name": name]
            do {
                let response = try await GatewayHTTPClient.delete(
                    path: "assistants/{assistantId}/secrets", json: body, timeout: 5
                )
                if response.isSuccess || response.statusCode == 404 {
                    log.info("Cleared assistant credential: \(name, privacy: .public) (status \(response.statusCode))")
                } else {
                    log.warning("Failed to clear assistant credential: \(name, privacy: .public) (status \(response.statusCode))")
                    allCleared = false
                }
            } catch {
                log.warning("Failed to clear assistant credential: \(name, privacy: .public) — \(error.localizedDescription)")
                allCleared = false
            }
        }
        if allCleared {
            log.info("All managed credentials cleared from assistant")
        } else {
            log.warning("Some managed credentials could not be cleared from assistant")
        }
        return allCleared
    }

    /// Resolves the current user ID from the auth session.
    private func resolveUserId() async throws -> String? {
        let session = try await authService.getSession()
        return session.data?.user?.id
    }

    /// Stable error code returned by the platform when a non-Vellum user
    /// already has a local assistant registered. Must stay in sync with the
    /// backend constant on `POST /v1/assistants/self-hosted-local/ensure-registration/`.
    private static let singleLocalAssistantLimitCode = "single_local_assistant_limit"

    /// Shape of the structured 400 body the platform returns for
    /// ensure-registration failures: `{success, code, detail}` (matches the
    /// OAuth error pattern). All fields are optional so unrelated 400s that
    /// don't follow this shape decode as `nil` and fall through.
    private struct EnsureRegistrationErrorBody: Decodable {
        let success: Bool?
        let code: String?
        let detail: String?
    }

    /// Returns true when the raw 400 body identifies the single-local-assistant
    /// limit specifically. Anything else (free-form text, missing code, other
    /// codes) returns false so the caller falls through to the generic
    /// registration-failed path.
    private static func isSingleLocalAssistantLimitError(_ body: String?) -> Bool {
        guard let data = body?.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(EnsureRegistrationErrorBody.self, from: data) else {
            return false
        }
        return parsed.code == singleLocalAssistantLimitCode
    }

    /// Returns the first self-hosted local assistant the caller has registered
    /// in the given organization, or nil if the list is empty / the request fails.
    /// Used to resolve the conflicting registration after a 400 from
    /// ensure-registration.
    private func firstExistingLocalAssistant(organizationId: String) async throws -> PlatformAssistant? {
        let assistants = try await authService.listSelfHostedLocalAssistants(organizationId: organizationId)
        return assistants.first
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
