import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AuthService")

@MainActor
public final class AuthService {
    public static let shared = AuthService()

    /// UserDefaults key for the connected organization ID.
    public static let connectedOrganizationIdKey = "connectedOrganizationId"

    private init() {}

    private struct AuthRequestConfig {
        let path: String
        let method: String
        let body: Any?
        let headers: [String: String]
        let retryAfterSession410: Bool
        let timeoutInterval: TimeInterval?

        init(
            path: String,
            method: String = "GET",
            body: Any? = nil,
            headers: [String: String] = [:],
            retryAfterSession410: Bool = false,
            timeoutInterval: TimeInterval? = nil
        ) {
            self.path = path
            self.method = method
            self.body = body
            self.headers = headers
            self.retryAfterSession410 = retryAfterSession410
            self.timeoutInterval = timeoutInterval
        }
    }

    private struct AuthAttemptResult {
        let data: Data
        let httpResponse: HTTPURLResponse?
        let didSendSessionToken: Bool

        var statusCode: Int {
            httpResponse?.statusCode ?? 0
        }
    }

    public func getConfig() async throws -> AllauthResponse<ConfigData> {
        try await request(AuthRequestConfig(path: "config", retryAfterSession410: true))
    }

    public func getSession(timeout: TimeInterval? = nil) async throws -> AllauthResponse<SessionData> {
        try await request(AuthRequestConfig(path: "auth/session", timeoutInterval: timeout))
    }

    public func logout() async throws -> AllauthResponse<EmptyData> {
        try await request(AuthRequestConfig(path: "auth/session", method: "DELETE"))
    }

    // NOTE: No longer used by startWorkOSLogin(). Retained for backward compatibility.
    public func authenticateWithProviderToken(
        provider: String,
        process: String,
        clientId: String,
        idToken: String?,
        accessToken: String?
    ) async throws -> AllauthResponse<SessionData> {
        var token: [String: String] = ["client_id": clientId]
        if let idToken { token["id_token"] = idToken }
        if let accessToken { token["access_token"] = accessToken }

        let body: [String: Any] = [
            "provider": provider,
            "process": process,
            "token": token,
        ]
        return try await request(AuthRequestConfig(path: "auth/provider/token", method: "POST", body: body))
    }

    // NOTE: No longer used by startWorkOSLogin(). Retained for backward compatibility.
    public func fetchOIDCDiscovery(url: String) async throws -> OIDCDiscovery {
        guard let requestURL = URL(string: url),
              requestURL.scheme?.lowercased() == "https" else {
            throw AuthServiceError.invalidURL
        }
        let (data, _) = try await URLSession.shared.data(from: requestURL)
        return try JSONDecoder().decode(OIDCDiscovery.self, from: data)
    }

    // NOTE: No longer used by startWorkOSLogin(). Retained for backward compatibility.
    public func exchangeOIDCCode(
        tokenEndpoint: String,
        clientId: String,
        code: String,
        codeVerifier: String,
        redirectURI: String
    ) async throws -> OIDCTokenResponse {
        guard let url = URL(string: tokenEndpoint),
              url.scheme?.lowercased() == "https" else {
            throw AuthServiceError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        let params = [
            "grant_type": "authorization_code",
            "client_id": clientId,
            "code": code,
            "code_verifier": codeVerifier,
            "redirect_uri": redirectURI,
        ]
        var formAllowed = CharacterSet.alphanumerics
        formAllowed.insert(charactersIn: "-._~")
        request.httpBody = params.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: formAllowed) ?? $0.value)" }
            .joined(separator: "&")
            .data(using: .utf8)

        let (data, _) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(OIDCTokenResponse.self, from: data)

        if let error = response.error {
            throw AuthServiceError.oidcTokenExchangeFailed(response.error_description ?? error)
        }
        return response
    }

    // MARK: - Platform Organizations API

    /// Fetch the current user's organizations. Does not require Vellum-Organization-Id header.
    public func getOrganizations() async throws -> [PlatformOrganization] {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/v1/organizations/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "GET"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")

        if let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Platform request GET organizations/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        do {
            let paginated = try JSONDecoder().decode(PaginatedOrganizationsResponse.self, from: data)
            return paginated.results
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }
    }

    public enum OrganizationResolutionError: LocalizedError, Sendable {
        case noOrganizations
        case multipleOrganizations

        public var errorDescription: String? {
            switch self {
            case .noOrganizations:
                return "No organizations found for this account"
            case .multipleOrganizations:
                return "Multiple organizations found. Multi-org support is not yet available — please contact support."
            }
        }
    }

    /// Resolve the caller's organization ID, persisting it under
    /// `connectedOrganizationId` in UserDefaults for synchronous readers.
    ///
    /// A persisted value is re-validated against the current org list on
    /// every call so stale cross-environment IDs don't leak through.
    @discardableResult
    public func resolveOrganizationId() async throws -> String {
        let orgs = try await getOrganizations()
        let persistedOrgId = UserDefaults.standard.string(forKey: Self.connectedOrganizationIdKey)
        if let persistedOrgId, orgs.contains(where: { $0.id == persistedOrgId }) {
            log.info("Validated persisted organization: \(persistedOrgId, privacy: .public)")
            return persistedOrgId
        }
        if persistedOrgId != nil {
            log.warning("Persisted organization ID not found in user's orgs — re-resolving")
        }
        switch orgs.count {
        case 0:
            throw OrganizationResolutionError.noOrganizations
        case 1:
            let orgId = orgs[0].id
            UserDefaults.standard.set(orgId, forKey: Self.connectedOrganizationIdKey)
            log.info("Resolved organization: \(orgId, privacy: .public)")
            return orgId
        default:
            throw OrganizationResolutionError.multipleOrganizations
        }
    }

    // MARK: - Platform Request Helper

    /// Raw result of a platform HTTP request — status code + body data.
    /// Callers interpret the status code themselves, because different
    /// endpoints treat 404/403 as either typed values or thrown errors.
    private struct PlatformResponse {
        let data: Data
        let statusCode: Int

        func decode<T: Decodable>(_ type: T.Type) throws -> T {
            switch statusCode {
            case 401:
                throw PlatformAPIError.authenticationRequired
            case 403:
                throw PlatformAPIError.accessDenied(detail: "Access denied")
            case 404:
                throw PlatformAPIError.notFound
            case 200..<300:
                do {
                    return try JSONDecoder().decode(type, from: data)
                } catch {
                    throw PlatformAPIError.decodingError(error.localizedDescription)
                }
            default:
                throw PlatformAPIError.serverError(
                    statusCode: statusCode,
                    detail: String(data: data, encoding: .utf8)
                )
            }
        }
    }

    /// Dispatch an authenticated platform API request and return the raw
    /// response. Centralizes URL construction, JSON headers, session-token
    /// injection, network-error mapping, and status-code logging — the
    /// boilerplate that used to be duplicated across every `v1/...` endpoint.
    ///
    /// Callers handle status codes themselves because endpoints disagree on
    /// semantics (e.g. `getAssistant` returns `.notFound` on 404 as a value,
    /// `refreshAssistant` throws on 404).
    private func performPlatformRequest(
        path: String,
        method: String,
        organizationId: String?,
        body: Data? = nil,
        timeoutInterval: TimeInterval? = nil
    ) async throws -> PlatformResponse {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/\(path)"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = body
        }
        if let organizationId {
            urlRequest.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")
        }
        if let timeoutInterval {
            urlRequest.timeoutInterval = timeoutInterval
        }

        if let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        log.debug("Platform request \(method) \(path) -> \(statusCode)")
        return PlatformResponse(data: data, statusCode: statusCode)
    }

    // MARK: - Platform Assistant API

    /// Map a platform assistant `GET` response into a `PlatformAssistantResult`.
    ///
    /// Shared by single-assistant lookup endpoints (`getAssistant`,
    /// `getActiveAssistant`) that all use the same `.found` / `.notFound` /
    /// `.accessDenied` status-code contract.
    private func decodeAssistantResult(
        _ response: PlatformResponse
    ) throws -> PlatformAssistantResult {
        switch response.statusCode {
        case 404:
            return .notFound
        case 403:
            return .accessDenied
        case 401:
            throw PlatformAPIError.authenticationRequired
        case 200..<300:
            do {
                return .found(try JSONDecoder().decode(PlatformAssistant.self, from: response.data))
            } catch {
                throw PlatformAPIError.decodingError(error.localizedDescription)
            }
        default:
            throw PlatformAPIError.serverError(
                statusCode: response.statusCode,
                detail: String(data: response.data, encoding: .utf8)
            )
        }
    }

    /// Retrieve a specific managed assistant by ID.
    public func getAssistant(id: String, organizationId: String) async throws -> PlatformAssistantResult {
        let response = try await performPlatformRequest(
            path: "v1/assistants/\(id)/",
            method: "GET",
            organizationId: organizationId
        )
        return try decodeAssistantResult(response)
    }

    /// Retrieve the user's currently active managed assistant.
    public func getActiveAssistant(organizationId: String) async throws -> PlatformAssistantResult {
        let response = try await performPlatformRequest(
            path: "v1/assistants/active/",
            method: "GET",
            organizationId: organizationId
        )
        return try decodeAssistantResult(response)
    }

    /// List managed assistants visible to the caller in the given organization.
    ///
    /// The backend already scopes the response to platform (cloud-hosted)
    /// assistants — self-hosted-local assistants are excluded by a hardcoded
    /// filter in the queryset — so no additional query parameter is needed.
    ///
    /// Used by the managed bootstrap flow to discover existing platform
    /// assistants before falling through to hatch. The platform caps each org
    /// at 5 managed assistants, which always fits in a single page, so
    /// pagination is not needed. Callers assume the platform returns
    /// newest-first and take `results.first`.
    public func listAssistants(organizationId: String) async throws -> [PlatformAssistant] {
        let response = try await performPlatformRequest(
            path: "v1/assistants/",
            method: "GET",
            organizationId: organizationId
        )
        return try response.decode(PaginatedPlatformAssistantsResponse.self).results
    }

    /// List self-hosted local assistant registrations for the caller.
    public func listSelfHostedLocalAssistants(organizationId: String) async throws -> [PlatformAssistant] {
        let response = try await performPlatformRequest(
            path: "v1/assistants/?hosting=local",
            method: "GET",
            organizationId: organizationId
        )
        return try response.decode(PaginatedPlatformAssistantsResponse.self).results
    }

    /// Create or retrieve a managed assistant via the idempotent hatch endpoint.
    /// Returns `.reusedExisting` on 200 (assistant already exists) or `.createdNew` on 201.
    public func hatchAssistant(
        organizationId: String,
        name: String? = nil,
        description: String? = nil,
        anthropicApiKey: String? = nil
    ) async throws -> HatchAssistantResult {
        let requestBody = HatchAssistantRequest(
            name: name,
            description: description,
            anthropic_api_key: anthropicApiKey
        )
        let bodyData = try JSONEncoder().encode(requestBody)

        let response = try await performPlatformRequest(
            path: "v1/assistants/hatch/",
            method: "POST",
            organizationId: organizationId,
            body: bodyData,
            timeoutInterval: 30
        )

        if response.statusCode == 401 {
            throw PlatformAPIError.authenticationRequired
        }

        if response.statusCode == 403 {
            // Surface the server's detail message (e.g. "Hatching is not
            // currently available for your account.") instead of collapsing
            // all 403s into a generic "Authentication required" error.
            let detail: String
            if let body = try? JSONDecoder().decode([String: String].self, from: response.data),
               let message = body["detail"] {
                detail = message
            } else {
                let raw = String(data: response.data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
                detail = (raw?.isEmpty == false) ? raw! : "Access denied"
            }
            throw PlatformAPIError.accessDenied(detail: detail)
        }

        guard (200..<300).contains(response.statusCode) else {
            let detail = String(data: response.data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: response.statusCode, detail: detail)
        }

        let assistant: PlatformAssistant
        do {
            assistant = try JSONDecoder().decode(PlatformAssistant.self, from: response.data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }

        return response.statusCode == 200 ? .reusedExisting(assistant) : .createdNew(assistant)
    }

    @discardableResult
    public func updateAssistant(
        id: String,
        organizationId: String,
        name: String? = nil,
        description: String? = nil
    ) async throws -> PlatformAssistant {
        var fields: [String: String] = [:]
        if let name { fields["name"] = name }
        if let description { fields["description"] = description }

        let response = try await performPlatformRequest(
            path: "v1/assistants/\(id)/",
            method: "PATCH",
            organizationId: organizationId,
            body: try JSONEncoder().encode(fields)
        )
        return try response.decode(PlatformAssistant.self)
    }

    // MARK: - Recovery Mode

    /// Enter recovery mode for a managed assistant.
    ///
    /// On success the platform pauses the normal assistant pod and mounts the workspace PVC
    /// into a debug pod. Returns the updated `PlatformAssistant` (fetched via `refreshAssistant`)
    /// which includes the populated `recovery_mode` field.
    ///
    /// The enter endpoint returns `{"detail": "...", "debug_pod_name": "..."}`, not a full
    /// assistant payload. We POST to trigger the transition and then re-fetch the assistant to
    /// get the authoritative updated state.
    public func enterRecoveryMode(
        assistantId: String,
        organizationId: String
    ) async throws -> PlatformAssistant {
        try await postRecoveryModeTransition(
            path: "maintenance-mode/enter",
            assistantId: assistantId,
            organizationId: organizationId
        )
        return try await refreshAssistant(id: assistantId, organizationId: organizationId)
    }

    /// Exit recovery mode for a managed assistant.
    ///
    /// On success the platform tears down the debug pod and resumes the normal assistant pod.
    /// Returns the updated `PlatformAssistant` (fetched via `refreshAssistant`) with
    /// `recovery_mode.enabled == false`.
    ///
    /// The exit endpoint returns `{"detail": "..."}`, not a full assistant payload. We POST to
    /// trigger the transition and then re-fetch the assistant to get the authoritative updated state.
    public func exitRecoveryMode(
        assistantId: String,
        organizationId: String
    ) async throws -> PlatformAssistant {
        try await postRecoveryModeTransition(
            path: "maintenance-mode/exit",
            assistantId: assistantId,
            organizationId: organizationId
        )
        return try await refreshAssistant(id: assistantId, organizationId: organizationId)
    }

    /// Shared POST helper for enter/exit recovery-mode transitions.
    /// The platform endpoints return a simple `{"detail": "..."}` body — not a full assistant
    /// payload — so we only check the status code here.
    private func postRecoveryModeTransition(
        path: String,
        assistantId: String,
        organizationId: String
    ) async throws {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/v1/assistants/\(assistantId)/\(path)/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = Data("{}".utf8)
        urlRequest.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        if let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Platform request POST assistants/\(assistantId)/\(path)/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }
    }

    /// Re-fetch a managed assistant's current detail from the platform.
    ///
    /// Convenience used after a recovery-mode mutation to get the freshest state without
    /// callers having to inline the `getAssistant` + result-unwrap pattern.
    /// Throws `PlatformAPIError.serverError(statusCode: 404, ...)` when the assistant is not
    /// found, and `PlatformAPIError.authenticationRequired` on 403/401.
    public func refreshAssistant(
        id: String,
        organizationId: String
    ) async throws -> PlatformAssistant {
        let result = try await getAssistant(id: id, organizationId: organizationId)
        switch result {
        case .found(let assistant):
            return assistant
        case .notFound:
            throw PlatformAPIError.serverError(statusCode: 404, detail: "Assistant not found")
        case .accessDenied:
            throw PlatformAPIError.authenticationRequired
        }
    }

    // MARK: - Self-Hosted Local Registration

    /// Ensure a self-hosted local assistant registration exists on the platform.
    public func ensureSelfHostedLocalRegistration(
        organizationId: String,
        clientInstallationId: String,
        runtimeAssistantId: String,
        clientPlatform: String,
        assistantVersion: String? = nil
    ) async throws -> EnsureSelfHostedLocalRegistrationResponse {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/v1/assistants/self-hosted-local/ensure-registration/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        if let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }

        let requestBody = EnsureSelfHostedLocalRegistrationRequest(
            clientInstallationId: clientInstallationId,
            runtimeAssistantId: runtimeAssistantId,
            clientPlatform: clientPlatform,
            assistantVersion: assistantVersion
        )
        let encoder = JSONEncoder()
        urlRequest.httpBody = try encoder.encode(requestBody)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Platform request POST assistants/self-hosted-local/ensure-registration/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        do {
            return try JSONDecoder().decode(EnsureSelfHostedLocalRegistrationResponse.self, from: data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }
    }

    /// Reprovision (rotate) the API key for a self-hosted local assistant.
    public func reprovisionSelfHostedLocalAssistantApiKey(
        organizationId: String,
        clientInstallationId: String,
        runtimeAssistantId: String,
        clientPlatform: String,
        assistantVersion: String? = nil
    ) async throws -> ReprovisionSelfHostedLocalApiKeyResponse {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/v1/assistants/self-hosted-local/reprovision-api-key/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        if let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }

        let requestBody = ReprovisionSelfHostedLocalApiKeyRequest(
            clientInstallationId: clientInstallationId,
            runtimeAssistantId: runtimeAssistantId,
            clientPlatform: clientPlatform,
            assistantVersion: assistantVersion
        )
        let encoder = JSONEncoder()
        urlRequest.httpBody = try encoder.encode(requestBody)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Platform request POST assistants/self-hosted-local/reprovision-api-key/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        do {
            return try JSONDecoder().decode(ReprovisionSelfHostedLocalApiKeyResponse.self, from: data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }
    }

    /// Retire (deregister) a self-hosted local assistant from the platform.
    ///
    /// Calls `DELETE /v1/assistants/{platformAssistantId}/retire/` to remove the
    /// platform-side registration created by `ensureSelfHostedLocalRegistration`.
    public func retireSelfHostedLocalAssistant(
        platformAssistantId: String,
        organizationId: String
    ) async throws {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/v1/assistants/\(platformAssistantId)/retire/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "DELETE"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")
        urlRequest.timeoutInterval = 15

        if let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Platform request DELETE assistants/\(platformAssistantId, privacy: .public)/retire/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        // 404 is acceptable — the registration may have already been removed.
        if statusCode == 404 {
            log.info("Platform assistant \(platformAssistantId, privacy: .public) not found — already deregistered")
            return
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }
    }

    // MARK: - Allauth Requests

    private func request<T: Codable>(_ requestConfig: AuthRequestConfig) async throws -> AllauthResponse<T> {
        var attempt = try await executeRequestAttempt(
            requestConfig: requestConfig,
            includeSessionToken: true
        )
        log.debug("Auth request \(requestConfig.method, privacy: .public) \(requestConfig.path, privacy: .public) -> \(attempt.statusCode, privacy: .public)")

        if await shouldRetryAfterSessionTokenGone(for: requestConfig, firstAttempt: attempt) {
            attempt = try await executeRequestAttempt(
                requestConfig: requestConfig,
                includeSessionToken: false
            )
            log.debug("Auth request retry \(requestConfig.method, privacy: .public) \(requestConfig.path, privacy: .public) -> \(attempt.statusCode, privacy: .public)")
        }

        let decoded: AllauthResponse<T>
        do {
            decoded = try JSONDecoder().decode(AllauthResponse<T>.self, from: attempt.data)
        } catch {
            let rawBody = String(data: attempt.data, encoding: .utf8) ?? "<non-utf8>"
            log.error("Failed to decode auth response for \(requestConfig.method, privacy: .public) \(requestConfig.path, privacy: .public): \(error)\nRaw body: \(rawBody, privacy: .private)")
            throw AuthServiceError.decodingError(error)
        }

        if let sessionToken = decoded.meta?.session_token {
            await SessionTokenManager.setTokenAsync(sessionToken)
        }

        return decoded
    }

    private func shouldRetryAfterSessionTokenGone(
        for requestConfig: AuthRequestConfig,
        firstAttempt: AuthAttemptResult
    ) async -> Bool {
        guard firstAttempt.statusCode == 410, firstAttempt.didSendSessionToken else {
            return false
        }

        log.warning("Auth request \(requestConfig.method, privacy: .public) \(requestConfig.path, privacy: .public) returned 410 with a session token; clearing stored session token.")
        await SessionTokenManager.deleteTokenAsync()

        guard requestConfig.retryAfterSession410 else {
            log.warning("Auth request \(requestConfig.method, privacy: .public) \(requestConfig.path, privacy: .public) returned 410 with a session token; endpoint policy disables retry.")
            return false
        }

        log.debug("Retrying auth request \(requestConfig.method, privacy: .public) \(requestConfig.path, privacy: .public) once without session token after 410.")
        return true
    }

    private func executeRequestAttempt(
        requestConfig: AuthRequestConfig,
        includeSessionToken: Bool
    ) async throws -> AuthAttemptResult {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/_allauth/app/v1/\(requestConfig.path)"
        guard let url = URL(string: urlString) else {
            throw AuthServiceError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = requestConfig.method
        if let timeout = requestConfig.timeoutInterval {
            urlRequest.timeoutInterval = timeout
        }
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var didSendSessionToken = false
        if includeSessionToken, let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
            didSendSessionToken = true
        }

        for (key, value) in requestConfig.headers {
            urlRequest.setValue(value, forHTTPHeaderField: key)
        }

        if let body = requestConfig.body {
            urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            log.error("Auth request \(requestConfig.method, privacy: .public) \(urlString, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            throw AuthServiceError.networkError(error)
        }

        return AuthAttemptResult(
            data: data,
            httpResponse: response as? HTTPURLResponse,
            didSendSessionToken: didSendSessionToken
        )
    }
}
