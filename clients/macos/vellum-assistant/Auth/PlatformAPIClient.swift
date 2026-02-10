import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "PlatformAPI")

struct UserProfile: Decodable {
    let id: String
    let email: String
    let name: String?
}

enum PlatformAPIError: LocalizedError {
    case notAuthenticated
    case httpError(statusCode: Int, body: String)
    case networkError(String)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated: return "Not authenticated"
        case .httpError(let code, let body): return "HTTP \(code): \(body)"
        case .networkError(let msg): return "Network error: \(msg)"
        }
    }
}

@MainActor
final class PlatformAPIClient {
    private let auth0Manager: Auth0Manager
    private let baseURL: URL
    private let session: URLSession

    init(auth0Manager: Auth0Manager, baseURL: URL) {
        self.auth0Manager = auth0Manager
        self.baseURL = baseURL

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.session = URLSession(configuration: config)
    }

    // MARK: - Generic Request

    func request<T: Decodable>(
        _ endpoint: String,
        method: String = "GET",
        body: (any Encodable)? = nil
    ) async throws -> T {
        guard auth0Manager.isAuthenticated else {
            throw PlatformAPIError.notAuthenticated
        }

        let accessToken = try await auth0Manager.getAccessToken()

        let url = baseURL.appendingPathComponent(endpoint)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let body {
            request.httpBody = try JSONEncoder().encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw PlatformAPIError.networkError("Invalid response")
        }

        if http.statusCode == 401 {
            log.warning("Received 401 — triggering re-login")
            try await auth0Manager.login()
            // Retry once with fresh token
            return try await retryRequest(endpoint, method: method, body: body)
        }

        guard (200..<300).contains(http.statusCode) else {
            let responseBody = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw PlatformAPIError.httpError(statusCode: http.statusCode, body: responseBody)
        }

        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - Convenience

    func getMe() async throws -> UserProfile {
        try await request("api/me")
    }

    // MARK: - Private

    private func retryRequest<T: Decodable>(
        _ endpoint: String,
        method: String,
        body: (any Encodable)?
    ) async throws -> T {
        let accessToken = try await auth0Manager.getAccessToken()

        let url = baseURL.appendingPathComponent(endpoint)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let body {
            request.httpBody = try JSONEncoder().encode(body)
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            let responseBody = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw PlatformAPIError.httpError(statusCode: status, body: responseBody)
        }

        return try JSONDecoder().decode(T.self, from: data)
    }
}
