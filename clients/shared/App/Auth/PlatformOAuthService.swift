import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "PlatformOAuthService")

// MARK: - Response Types

public struct OAuthStartResponse: Codable, Sendable {
    public let success: Bool
    public let deferred: Bool
    public let provider: String
    public let connect_url: String
    public let state_id: String?

    enum CodingKeys: String, CodingKey {
        case success
        case deferred
        case provider
        case connect_url
        case state_id
    }
}

public struct OAuthConnectionEntry: Codable, Sendable {
    public let id: String
    public let provider: String
    public let status: String
    public let connected: Bool
    public let account_label: String?
    public let scopes_granted: [String]?
    public let expires_at: String?

    enum CodingKeys: String, CodingKey {
        case id
        case provider
        case status
        case connected
        case account_label
        case scopes_granted
        case expires_at
    }
}

// MARK: - Service

@MainActor
public final class PlatformOAuthService {
    public static let shared = PlatformOAuthService()

    private init() {}

    // MARK: - Private Helpers

    private func authenticatedRequest(url: URL, method: String) async throws -> URLRequest {
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")

        if let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }

        guard let organizationId = UserDefaults.standard.string(forKey: "connectedOrganizationId") else {
            throw PlatformAPIError.authenticationRequired
        }
        urlRequest.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        return urlRequest
    }

    // MARK: - Public Methods

    /// Start an OAuth flow for the given provider and assistant.
    public func startOAuthConnect(provider: String, assistantId: String, redirectAfterConnect: String? = nil) async throws -> OAuthStartResponse {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/v1/assistants/\(assistantId)/oauth/\(provider)/start/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = try await authenticatedRequest(url: url, method: "POST")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let redirectValue = redirectAfterConnect ?? "/"
        let body: [String: Any] = [
            "requested_scopes": [] as [String],
            "redirect_after_connect": redirectValue
        ]
        urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Platform request POST assistants/\(assistantId)/oauth/\(provider)/start/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        do {
            return try JSONDecoder().decode(OAuthStartResponse.self, from: data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }
    }

    /// List OAuth connections for the given assistant.
    public func listConnections(assistantId: String) async throws -> [OAuthConnectionEntry] {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/v1/assistants/\(assistantId)/oauth/connections/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        let urlRequest = try await authenticatedRequest(url: url, method: "GET")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Platform request GET assistants/\(assistantId)/oauth/connections/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        do {
            return try JSONDecoder().decode([OAuthConnectionEntry].self, from: data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }
    }

    /// Disconnect a specific OAuth connection for the given assistant.
    public func disconnectConnection(assistantId: String, connectionId: String) async throws {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/v1/assistants/\(assistantId)/oauth/connections/\(connectionId)/disconnect/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = try await authenticatedRequest(url: url, method: "POST")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = "{}".data(using: .utf8)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Platform request POST assistants/\(assistantId)/oauth/connections/\(connectionId)/disconnect/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }
    }
}
