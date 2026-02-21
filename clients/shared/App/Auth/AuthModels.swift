import Foundation

public struct AllauthError: Codable, Sendable {
    public let code: String
    public let message: String
    public let param: String?
}

public struct AllauthMeta: Codable, Sendable {
    public let is_authenticated: Bool?
    public let session_token: String?
    public let access_token: String?
}

public struct AllauthUser: Codable, Sendable {
    public let id: String?
    public let email: String?
    public let username: String?
    public let display: String?

    enum CodingKeys: String, CodingKey {
        case id, email, username, display
    }

    public init(from decoder: Decoder) throws {
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

public struct AllauthFlow: Codable, Sendable {
    public let id: String
    public let is_pending: Bool?
}

public struct SessionData: Codable, Sendable {
    public let user: AllauthUser?
    public let flows: [AllauthFlow]?
}

public struct ProviderConfig: Codable, Sendable {
    public let id: String
    public let name: String?
    public let client_id: String?
    public let openid_configuration_url: String?
    public let flows: [String]?
}

public struct SocialAccountConfig: Codable, Sendable {
    public let providers: [ProviderConfig]?
}

public struct AccountConfig: Codable, Sendable {
    public let is_open_for_signup: Bool?
    public let login_methods: [String]?
}

public struct ConfigData: Codable, Sendable {
    public let account: AccountConfig?
    public let socialaccount: SocialAccountConfig?
}

public struct OIDCDiscovery: Codable, Sendable {
    public let authorization_endpoint: String?
    public let token_endpoint: String?
}

public struct OIDCTokenResponse: Codable, Sendable {
    public let id_token: String?
    public let access_token: String?
    public let error: String?
    public let error_description: String?
}

public struct AllauthResponse<T: Codable>: Codable {
    public let status: Int
    public let data: T?
    public let meta: AllauthMeta?
    public let errors: [AllauthError]?
}

public enum AuthServiceError: LocalizedError {
    case invalidURL
    case networkError(Error)
    case decodingError(Error)
    case serverError(Int, [AllauthError])
    case noSessionToken
    case oidcDiscoveryFailed
    case oidcTokenExchangeFailed(String)

    public var errorDescription: String? {
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

public struct EmptyData: Codable, Sendable {}
