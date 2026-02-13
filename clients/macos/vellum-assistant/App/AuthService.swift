import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AuthService")

struct AllauthError: Codable {
    let code: String
    let message: String
    let param: String?
}

struct AllauthMeta: Codable {
    let is_authenticated: Bool?
    let session_token: String?
    let access_token: String?
}

struct AllauthUser: Codable {
    let id: String?
    let email: String?
    let username: String?
    let display: String?

    enum CodingKeys: String, CodingKey {
        case id, email, username, display
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let intId = try? container.decode(Int.self, forKey: .id) {
            id = String(intId)
        } else {
            id = try container.decodeIfPresent(String.self, forKey: .id)
        }
        email = try container.decodeIfPresent(String.self, forKey: .email)
        username = try container.decodeIfPresent(String.self, forKey: .username)
        display = try container.decodeIfPresent(String.self, forKey: .display)
    }
}

struct AllauthFlow: Codable {
    let id: String
    let is_pending: Bool?
}

struct SessionData: Codable {
    let user: AllauthUser?
    let methods: [[String: AnyCodableValue]]?
    let flows: [AllauthFlow]?
}

struct AllauthResponse<T: Codable>: Codable {
    let status: Int
    let data: T?
    let meta: AllauthMeta?
    let errors: [AllauthError]?
}

struct ProviderConfig: Codable {
    let id: String
    let name: String?
    let client_id: String?
    let openid_configuration_url: String?
    let flows: [String]?
}

struct SocialAccountConfig: Codable {
    let providers: [ProviderConfig]?
}

struct AccountConfig: Codable {
    let is_open_for_signup: Bool?
    let login_methods: [String]?
}

struct ConfigData: Codable {
    let account: AccountConfig?
    let socialaccount: SocialAccountConfig?
}

struct ProviderSignupAccount: Codable {
    let provider: String?
    let uid: String?
    let display: String?
}

struct ProviderSignupEmail: Codable {
    let email: String?
    let verified: Bool?
    let primary: Bool?
}

struct ProviderSignupInfoData: Codable {
    let account: ProviderSignupAccount?
    let email: [ProviderSignupEmail]?
    let user: AllauthUser?
}

struct EmailVerificationInfoData: Codable {
    let email: String?
    let user: AllauthUser?
}

struct OIDCDiscovery: Codable {
    let authorization_endpoint: String?
    let token_endpoint: String?
}

struct OIDCTokenResponse: Codable {
    let id_token: String?
    let access_token: String?
    let error: String?
    let error_description: String?
}

enum AnyCodableValue: Codable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let v = try? container.decode(String.self) { self = .string(v) }
        else if let v = try? container.decode(Int.self) { self = .int(v) }
        else if let v = try? container.decode(Double.self) { self = .double(v) }
        else if let v = try? container.decode(Bool.self) { self = .bool(v) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let v): try container.encode(v)
        case .int(let v): try container.encode(v)
        case .double(let v): try container.encode(v)
        case .bool(let v): try container.encode(v)
        case .null: try container.encodeNil()
        }
    }
}

enum AuthServiceError: LocalizedError {
    case invalidURL
    case networkError(Error)
    case decodingError(Error)
    case serverError(Int, [AllauthError])
    case noSessionToken
    case oidcDiscoveryFailed
    case oidcTokenExchangeFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .networkError(let error): return error.localizedDescription
        case .decodingError(let error): return "Failed to decode response: \(error.localizedDescription)"
        case .serverError(_, let errors):
            return errors.first?.message ?? "Server error"
        case .noSessionToken: return "No session token received"
        case .oidcDiscoveryFailed: return "Unable to fetch OIDC discovery document"
        case .oidcTokenExchangeFailed(let msg): return msg
        }
    }
}

@MainActor
final class AuthService {
    static let shared = AuthService()

    private static let defaultBaseURL = "https://platform.vellum.ai"

    var baseURL: String {
        UserDefaults.standard.string(forKey: "authServiceBaseURL") ?? Self.defaultBaseURL
    }

    private init() {}

    func getConfig() async throws -> AllauthResponse<ConfigData> {
        try await request(path: "config")
    }

    func getSession() async throws -> AllauthResponse<SessionData> {
        try await request(path: "auth/session")
    }

    func logout() async throws -> AllauthResponse<EmptyData> {
        try await request(path: "auth/session", method: "DELETE")
    }

    func login(email: String, password: String) async throws -> AllauthResponse<SessionData> {
        try await request(path: "auth/login", method: "POST", body: [
            "email": email,
            "password": password,
        ])
    }

    func signup(email: String, username: String, password: String) async throws -> AllauthResponse<SessionData> {
        try await request(path: "auth/signup", method: "POST", body: [
            "email": email,
            "username": username,
            "password": password,
        ])
    }

    func authenticateWithProviderToken(
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
        return try await request(path: "auth/provider/token", method: "POST", body: body)
    }

    func getProviderSignupInfo() async throws -> AllauthResponse<ProviderSignupInfoData> {
        try await request(path: "auth/provider/signup")
    }

    func completeProviderSignup(email: String, username: String) async throws -> AllauthResponse<SessionData> {
        try await request(path: "auth/provider/signup", method: "POST", body: [
            "email": email,
            "username": username,
        ])
    }

    func verifyEmail(key: String) async throws -> AllauthResponse<SessionData> {
        try await request(path: "auth/email/verify", method: "POST", body: [
            "key": key,
        ])
    }

    func getEmailVerificationInfo(key: String) async throws -> AllauthResponse<EmailVerificationInfoData> {
        try await request(path: "auth/email/verify", headers: [
            "X-Email-Verification-Key": key,
        ])
    }

    func requestPasswordReset(email: String) async throws -> AllauthResponse<EmptyData> {
        try await request(path: "auth/password/request", method: "POST", body: [
            "email": email,
        ])
    }

    func resetPassword(key: String, password: String) async throws -> AllauthResponse<SessionData> {
        try await request(path: "auth/password/reset", method: "POST", body: [
            "key": key,
            "password": password,
        ])
    }

    func fetchOIDCDiscovery(url: String) async throws -> OIDCDiscovery {
        guard let requestURL = URL(string: url) else {
            throw AuthServiceError.invalidURL
        }
        let (data, _) = try await URLSession.shared.data(from: requestURL)
        return try JSONDecoder().decode(OIDCDiscovery.self, from: data)
    }

    func exchangeOIDCCode(
        tokenEndpoint: String,
        clientId: String,
        code: String,
        codeVerifier: String,
        redirectURI: String
    ) async throws -> OIDCTokenResponse {
        guard let url = URL(string: tokenEndpoint) else {
            throw AuthServiceError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        let params = [
            "grant_type": "authorization_code",
            "client_id": clientId,
            "code_verifier": codeVerifier,
            "code": code,
            "redirect_uri": redirectURI,
        ]
        request.httpBody = params.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0.value)" }
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
        headers: [String: String] = [:]
    ) async throws -> AllauthResponse<T> {
        let urlString = "\(baseURL)/_allauth/app/v1/\(path)"
        guard let url = URL(string: urlString) else {
            throw AuthServiceError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")

        if let token = SessionTokenManager.getToken() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        }

        for (key, value) in headers {
            urlRequest.setValue(value, forHTTPHeaderField: key)
        }

        if let body {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw AuthServiceError.networkError(error)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Auth request \(method) \(path) -> \(statusCode)")

        let decoded: AllauthResponse<T>
        do {
            decoded = try JSONDecoder().decode(AllauthResponse<T>.self, from: data)
        } catch {
            log.error("Failed to decode auth response: \(error)")
            throw AuthServiceError.decodingError(error)
        }

        if let sessionToken = decoded.meta?.session_token {
            SessionTokenManager.setToken(sessionToken)
        }

        return decoded
    }
}

struct EmptyData: Codable {}
