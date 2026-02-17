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

struct SessionData: Codable {
    let user: AllauthUser?
}

struct AllauthResponse<T: Codable>: Codable {
    let status: Int
    let data: T?
    let meta: AllauthMeta?
    let errors: [AllauthError]?
}

enum AuthServiceError: LocalizedError {
    case invalidURL
    case networkError(Error)
    case decodingError(Error)
    case serverError(Int, [AllauthError])
    case authFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .networkError(let error): return error.localizedDescription
        case .decodingError(let error): return "Failed to decode response: \(error.localizedDescription)"
        case .serverError(_, let errors):
            return errors.first?.message ?? "Server error"
        case .authFailed(let msg): return msg
        }
    }
}

@MainActor
final class AuthService {
    static let shared = AuthService()

    private static let defaultBaseURL: String = {
        #if DEBUG
        return "http://localhost:8000"
        #else
        return "https://app.vellum.ai"
        #endif
    }()

    var baseURL: String {
        UserDefaults.standard.string(forKey: "authServiceBaseURL") ?? Self.defaultBaseURL
    }

    private init() {}

    func getSession() async throws -> AllauthResponse<SessionData> {
        try await request(path: "auth/session")
    }

    func logout() async throws -> AllauthResponse<EmptyData> {
        try await request(path: "auth/session", method: "DELETE")
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
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let token = await SessionTokenManager.getTokenAsync() {
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
            let rawBody = String(data: data, encoding: .utf8) ?? "<non-utf8>"
            log.error("Failed to decode auth response for \(method) \(path): \(error)\nRaw body: \(rawBody)")
            throw AuthServiceError.decodingError(error)
        }

        if let sessionToken = decoded.meta?.session_token {
            await SessionTokenManager.setTokenAsync(sessionToken)
        }

        return decoded
    }
}

struct EmptyData: Codable {}
