import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "PlatformTwitterOAuth")

/// Protocol abstracting URLSession for testability.
public protocol URLSessionProtocol: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: URLSessionProtocol {}

/// A Twitter OAuth connection returned by the platform.
public struct TwitterOAuthConnection: Codable, Sendable {
    public let provider: String
    public let status: String           // "ACTIVE", "REVOKED", "EXPIRED"
    public let connected: Bool
    public let accountLabel: String?
    public let scopesGranted: [String]?
    public let expiresAt: String?

    enum CodingKeys: String, CodingKey {
        case provider
        case status
        case connected
        case accountLabel = "account_label"
        case scopesGranted = "scopes_granted"
        case expiresAt = "expires_at"
    }

    public init(provider: String, status: String, connected: Bool, accountLabel: String? = nil, scopesGranted: [String]? = nil, expiresAt: String? = nil) {
        self.provider = provider
        self.status = status
        self.connected = connected
        self.accountLabel = accountLabel
        self.scopesGranted = scopesGranted
        self.expiresAt = expiresAt
    }
}

/// Response from starting a Twitter OAuth connect flow.
public struct StartTwitterConnectResponse: Codable, Sendable {
    public let success: Bool
    public let deferred: Bool
    public let provider: String
    public let connectUrl: String
    public let stateId: String

    enum CodingKeys: String, CodingKey {
        case success
        case deferred
        case provider
        case connectUrl = "connect_url"
        case stateId = "state_id"
    }

    public init(success: Bool, deferred: Bool, provider: String, connectUrl: String, stateId: String) {
        self.success = success
        self.deferred = deferred
        self.provider = provider
        self.connectUrl = connectUrl
        self.stateId = stateId
    }
}

/// Response from disconnecting Twitter.
public struct DisconnectTwitterResponse: Codable, Sendable {
    public let success: Bool

    public init(success: Bool) {
        self.success = success
    }
}

/// Service for communicating with the platform's Twitter OAuth endpoints.
///
/// Provides methods to list connections, initiate OAuth flows, and disconnect Twitter
/// for a given platform assistant. Uses `PlatformAssistantIdResolver` to resolve the
/// platform assistant ID, and follows the same auth patterns as `AuthService`
/// (`X-Session-Token`, `Vellum-Organization-Id`).
public final class PlatformTwitterOAuthService: @unchecked Sendable {

    private let baseURL: String
    private let session: URLSessionProtocol
    private let sessionTokenProvider: @Sendable () async -> String?

    /// The OAuth scopes requested when starting a Twitter connect flow.
    public static let requestedScopes: [String] = [
        "tweet.read",
        "tweet.write",
        "users.read",
        "offline.access",
    ]

    /// The URL scheme callback the platform redirects to after OAuth completes.
    /// Uses the app's custom URL scheme so ASWebAuthenticationSession can intercept
    /// the redirect and return control to the app automatically.
    public static let callbackURLScheme = "vellum-assistant"
    public static let redirectAfterConnect = "vellum-assistant://oauth/twitter/callback"

    /// Creates a new service instance.
    ///
    /// - Parameters:
    ///   - baseURL: The platform base URL (e.g., `https://platform.vellum.ai`).
    ///   - session: The URLSession (or mock) to use for HTTP requests.
    ///   - sessionTokenProvider: Closure that returns the current session token, or nil if unauthenticated.
    public init(
        baseURL: String,
        session: URLSessionProtocol = URLSession.shared,
        sessionTokenProvider: @escaping @Sendable () async -> String? = { await SessionTokenManager.getTokenAsync() }
    ) {
        self.baseURL = baseURL
        self.session = session
        self.sessionTokenProvider = sessionTokenProvider
    }

    // MARK: - List Connections

    /// Lists Twitter OAuth connections for the given platform assistant.
    ///
    /// - Parameters:
    ///   - platformAssistantId: The platform assistant UUID.
    ///   - organizationId: The organization ID.
    /// - Returns: The list of Twitter OAuth connections.
    public func listConnections(
        platformAssistantId: String,
        organizationId: String
    ) async throws -> [TwitterOAuthConnection] {
        let urlString = "\(baseURL)/v1/assistants/\(platformAssistantId)/oauth/connections/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        try await applySessionToken(to: &request)

        let (data, response) = try await performRequest(request)
        let statusCode = httpStatusCode(response)

        log.debug("Platform request GET assistants/\(platformAssistantId, privacy: .public)/oauth/connections/ -> \(statusCode)")

        try checkAuthErrors(statusCode: statusCode)

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        do {
            return try JSONDecoder().decode([TwitterOAuthConnection].self, from: data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }
    }

    // MARK: - Start Twitter Connect

    /// Initiates the Twitter OAuth connect flow for the given platform assistant.
    ///
    /// - Parameters:
    ///   - platformAssistantId: The platform assistant UUID.
    ///   - organizationId: The organization ID.
    /// - Returns: A response containing the authorization URL to open in a browser.
    public func startTwitterConnect(
        platformAssistantId: String,
        organizationId: String
    ) async throws -> StartTwitterConnectResponse {
        let urlString = "\(baseURL)/v1/assistants/\(platformAssistantId)/oauth/twitter/start/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        try await applySessionToken(to: &request)

        let body: [String: Any] = [
            "requested_scopes": Self.requestedScopes,
            "redirect_after_connect": Self.redirectAfterConnect,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await performRequest(request)
        let statusCode = httpStatusCode(response)

        log.debug("Platform request POST assistants/\(platformAssistantId, privacy: .public)/oauth/twitter/start/ -> \(statusCode)")

        try checkAuthErrors(statusCode: statusCode)

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        do {
            return try JSONDecoder().decode(StartTwitterConnectResponse.self, from: data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }
    }

    // MARK: - Disconnect Twitter

    /// Disconnects (revokes) a Twitter connection for the given platform assistant.
    ///
    /// - Parameters:
    ///   - platformAssistantId: The platform assistant UUID.
    ///   - organizationId: The organization ID.
    /// - Returns: A response indicating whether the disconnect succeeded.
    public func disconnectTwitter(
        platformAssistantId: String,
        organizationId: String
    ) async throws -> DisconnectTwitterResponse {
        let urlString = "\(baseURL)/v1/assistants/\(platformAssistantId)/oauth/twitter/disconnect/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        try await applySessionToken(to: &request)

        let (data, response) = try await performRequest(request)
        let statusCode = httpStatusCode(response)

        log.debug("Platform request POST assistants/\(platformAssistantId, privacy: .public)/oauth/twitter/disconnect/ -> \(statusCode)")

        try checkAuthErrors(statusCode: statusCode)

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        do {
            return try JSONDecoder().decode(DisconnectTwitterResponse.self, from: data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }
    }

    // MARK: - Helpers

    private func applySessionToken(to request: inout URLRequest) async throws {
        if let token = await sessionTokenProvider() {
            request.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }
    }

    private func performRequest(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch let error as PlatformAPIError {
            throw error
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }
    }

    private func httpStatusCode(_ response: URLResponse) -> Int {
        (response as? HTTPURLResponse)?.statusCode ?? 0
    }

    private func checkAuthErrors(statusCode: Int) throws {
        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }
    }
}
