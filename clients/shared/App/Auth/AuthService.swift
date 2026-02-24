import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AuthService")

@MainActor
public final class AuthService {
    internal typealias RequestExecutor = (URLRequest) async throws -> (Data, URLResponse)

    public static let shared = AuthService()
    private let requestExecutor: RequestExecutor
    private let getSessionToken: () async -> String?
    private let setSessionToken: (String) async -> Void
    private let invalidateSessionToken: () async -> Void
    private let baseURLOverride: String?

    private static let defaultBaseURL: String = {
        #if DEBUG && os(macOS)
        return "http://localhost:8000"
        #else
        return "https://platform.vellum.ai"
        #endif
    }()

    public var baseURL: String {
        if let baseURLOverride, !baseURLOverride.isEmpty {
            return baseURLOverride
        }
        #if DEBUG
        // Allow overriding the auth service URL via UserDefaults for development/testing.
        if let override = UserDefaults.standard.string(forKey: "authServiceBaseURL"), !override.isEmpty {
            return override
        }
        #endif
        return Self.defaultBaseURL
    }

    private init() {
        self.baseURLOverride = nil
        self.requestExecutor = { request in
            try await URLSession.shared.data(for: request)
        }
        self.getSessionToken = {
            await SessionTokenManager.getTokenAsync()
        }
        self.setSessionToken = { token in
            await SessionTokenManager.setTokenAsync(token)
        }
        self.invalidateSessionToken = {
            await SessionTokenManager.invalidateTokenAsync()
        }
    }

    internal init(
        baseURLOverride: String? = nil,
        requestExecutor: @escaping RequestExecutor,
        getSessionToken: @escaping () async -> String?,
        setSessionToken: @escaping (String) async -> Void,
        invalidateSessionToken: @escaping () async -> Void
    ) {
        self.baseURLOverride = baseURLOverride
        self.requestExecutor = requestExecutor
        self.getSessionToken = getSessionToken
        self.setSessionToken = setSessionToken
        self.invalidateSessionToken = invalidateSessionToken
    }

    public func getConfig() async throws -> AllauthResponse<ConfigData> {
        try await request(path: "config", includeSessionToken: false)
    }

    public func hasSessionToken() async -> Bool {
        await getSessionToken() != nil
    }

    public func clearSessionToken() async {
        await invalidateSessionToken()
    }

    public func getSession() async throws -> AllauthResponse<SessionData> {
        try await request(path: "auth/session", includeSessionToken: true)
    }

    public func logout() async throws -> AllauthResponse<EmptyData> {
        try await request(path: "auth/session", method: "DELETE", includeSessionToken: true)
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
        return try await request(path: "auth/provider/token", method: "POST", body: body, includeSessionToken: true)
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

    private func request<T: Codable>(
        path: String,
        method: String = "GET",
        body: Any? = nil,
        includeSessionToken: Bool = true,
        headers: [String: String] = [:]
    ) async throws -> AllauthResponse<T> {
        let urlString = "\(baseURL)/_allauth/app/v1/\(path)"
        guard let url = URL(string: urlString) else {
            throw AuthServiceError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if includeSessionToken, let token = await getSessionToken() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        }

        for (key, value) in headers {
            urlRequest.setValue(value, forHTTPHeaderField: key)
        }

        if let body {
            urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await requestExecutor(urlRequest)
        } catch {
            throw AuthServiceError.networkError(error)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Auth request \(method) \(path) -> \(statusCode)")

        if statusCode == 410 {
            await invalidateSessionToken()
            throw AuthServiceError.invalidSessionToken
        }

        let decoded: AllauthResponse<T>
        do {
            decoded = try JSONDecoder().decode(AllauthResponse<T>.self, from: data)
        } catch {
            let rawBody = String(data: data, encoding: .utf8) ?? "<non-utf8>"
            log.error("Failed to decode auth response for \(method, privacy: .public) \(path, privacy: .public): \(error)\nRaw body: \(rawBody, privacy: .private)")
            throw AuthServiceError.decodingError(error)
        }

        if let sessionToken = decoded.meta?.session_token {
            await setSessionToken(sessionToken)
        }

        return decoded
    }
}
