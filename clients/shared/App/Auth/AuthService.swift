import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AuthService")

// MARK: - Thread-safe configuredBaseURL storage (module-private)
// These live outside the @MainActor class so they are nonisolated by default.
// GatewayHTTPClient (nonisolated) reads via AuthService.currentConfiguredBaseURL;
// SettingsStore (@MainActor) writes via AuthService.shared.configuredBaseURL.
private let _configuredBaseURLLock = NSLock()
private var _configuredBaseURLValue: String = ""

@MainActor
public final class AuthService {
    public static let shared = AuthService()
    private static let platformURLOverrideEnvironmentKey = "VELLUM_PLATFORM_URL"
    private static let authServiceBaseURLDefaultsName = "authServiceBaseURL"

    private static let defaultBaseURL: String = {
        #if DEBUG && os(macOS)
        return "http://localhost:8000"
        #else
        return "https://platform.vellum.ai"
        #endif
    }()

    /// Platform base URL from daemon config. Set by SettingsStore when the
    /// `platform_config_response` arrives. When non-empty, takes precedence
    /// over persisted defaults, but an explicit per-launch env override still wins.
    ///
    /// Backed by a lock-protected static so that `GatewayHTTPClient` (nonisolated)
    /// can read the value without crossing into `@MainActor` isolation.
    public var configuredBaseURL: String {
        get {
            _configuredBaseURLLock.lock()
            defer { _configuredBaseURLLock.unlock() }
            return _configuredBaseURLValue
        }
        set {
            _configuredBaseURLLock.lock()
            defer { _configuredBaseURLLock.unlock() }
            _configuredBaseURLValue = newValue
        }
    }

    /// Read the current configured base URL from any isolation context.
    /// Uses lock-based synchronization — safe to call from nonisolated code.
    nonisolated static var currentConfiguredBaseURL: String {
        _configuredBaseURLLock.lock()
        defer { _configuredBaseURLLock.unlock() }
        return _configuredBaseURLValue
    }

    public var baseURL: String {
        Self.resolveBaseURL(
            configuredBaseURL: configuredBaseURL,
            environment: ProcessInfo.processInfo.environment,
            userDefaults: .standard
        )
    }

    private init() {}

    /// Pure URL resolution logic — safe to call from any isolation context.
    /// All inputs are value types; no mutable shared state is accessed.
    nonisolated static func resolveBaseURL(
        configuredBaseURL: String,
        environment: [String: String],
        userDefaults: UserDefaults
    ) -> String {
        if let override = normalizedBaseURL(environment[platformURLOverrideEnvironmentKey]) {
            return override
        }
        if let configured = normalizedBaseURL(configuredBaseURL) {
            return configured
        }
        #if DEBUG
        // Keep the UserDefaults override as a fallback for direct debug sessions.
        if let override = normalizedBaseURL(userDefaults.string(forKey: authServiceBaseURLDefaultsName)) {
            return override
        }
        #endif
        return defaultBaseURL
    }

    nonisolated private static func normalizedBaseURL(_ raw: String?) -> String? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let normalized = trimmed.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        return normalized.isEmpty ? nil : normalized
    }

    private struct AuthRequestConfig {
        let path: String
        let method: String
        let body: Any?
        let headers: [String: String]
        let retryAfterSession410: Bool

        init(
            path: String,
            method: String = "GET",
            body: Any? = nil,
            headers: [String: String] = [:],
            retryAfterSession410: Bool = false
        ) {
            self.path = path
            self.method = method
            self.body = body
            self.headers = headers
            self.retryAfterSession410 = retryAfterSession410
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

    public func getSession() async throws -> AllauthResponse<SessionData> {
        try await request(AuthRequestConfig(path: "auth/session"))
    }

    public func logout() async throws -> AllauthResponse<EmptyData> {
        try await request(AuthRequestConfig(path: "auth/session", method: "DELETE"))
    }

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

    public func fetchOIDCDiscovery(url: String) async throws -> OIDCDiscovery {
        guard let requestURL = URL(string: url),
              requestURL.scheme?.lowercased() == "https" else {
            throw AuthServiceError.invalidURL
        }
        let (data, _) = try await URLSession.shared.data(from: requestURL)
        return try JSONDecoder().decode(OIDCDiscovery.self, from: data)
    }

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
        let urlString = "\(baseURL)/v1/organizations/"
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

    // MARK: - Platform Assistant API

    /// Retrieve a specific managed assistant by ID.
    public func getAssistant(id: String, organizationId: String) async throws -> PlatformAssistantResult {
        let urlString = "\(baseURL)/v1/assistants/\(id)/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "GET"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
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

        log.debug("Platform request GET assistants/\(id)/ -> \(statusCode)")

        if statusCode == 404 {
            return .notFound
        }

        if statusCode == 403 {
            return .accessDenied
        }

        if statusCode == 401 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        do {
            let assistant = try JSONDecoder().decode(PlatformAssistant.self, from: data)
            return .found(assistant)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }
    }

    /// Create or retrieve a managed assistant via the idempotent hatch endpoint.
    /// Returns `.reusedExisting` on 200 (assistant already exists) or `.createdNew` on 201.
    public func hatchAssistant(
        organizationId: String,
        name: String? = nil,
        description: String? = nil,
        anthropicApiKey: String? = nil
    ) async throws -> HatchAssistantResult {
        let urlString = "\(baseURL)/v1/assistants/hatch/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.timeoutInterval = 30
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        if let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }

        let requestBody = HatchAssistantRequest(
            name: name,
            description: description,
            anthropic_api_key: anthropicApiKey
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

        log.debug("Platform request POST assistants/hatch/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        let assistant: PlatformAssistant
        do {
            assistant = try JSONDecoder().decode(PlatformAssistant.self, from: data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }

        if statusCode == 200 {
            return .reusedExisting(assistant)
        } else {
            return .createdNew(assistant)
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
        let urlString = "\(baseURL)/v1/assistants/self-hosted-local/ensure-registration/"
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
        let urlString = "\(baseURL)/v1/assistants/self-hosted-local/reprovision-api-key/"
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
        let urlString = "\(baseURL)/_allauth/app/v1/\(requestConfig.path)"
        guard let url = URL(string: urlString) else {
            throw AuthServiceError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = requestConfig.method
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
