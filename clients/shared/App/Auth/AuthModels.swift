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

// MARK: - Organization Models

public struct PlatformOrganization: Codable, Sendable {
    public let id: String
    public let name: String?
}

public struct PaginatedOrganizationsResponse: Codable, Sendable {
    public let count: Int
    public let results: [PlatformOrganization]
}

// MARK: - Platform Assistant API Models

public struct PlatformAssistant: Codable, Sendable {
    public let id: String
    public let name: String?
    public let description: String?
    public let created_at: String?
    public let status: String?

    public init(id: String, name: String? = nil, description: String? = nil, created_at: String? = nil, status: String? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.created_at = created_at
        self.status = status
    }
}

public struct HatchAssistantRequest: Codable, Sendable {
    public let name: String?
    public let description: String?
    public let anthropic_api_key: String?

    public init(name: String? = nil, description: String? = nil, anthropic_api_key: String? = nil) {
        self.name = name
        self.description = description
        self.anthropic_api_key = anthropic_api_key
    }
}

/// Result type for platform assistant lookups where 404/403 are normal outcomes.
public enum PlatformAssistantResult: Sendable {
    case found(PlatformAssistant)
    case notFound
    case accessDenied
}

/// Result type for the idempotent hatch endpoint (200 = existing, 201 = created).
public enum HatchAssistantResult: Sendable {
    case reusedExisting(PlatformAssistant)
    case createdNew(PlatformAssistant)
}

/// Errors specific to platform API calls (non-allauth endpoints).
public enum PlatformAPIError: LocalizedError, Sendable {
    case invalidURL
    case networkError(String)
    case decodingError(String)
    case serverError(statusCode: Int, detail: String?)
    case authenticationRequired

    public var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL"
        case .networkError(let message):
            return message
        case .decodingError(let message):
            return "Failed to decode response: \(message)"
        case .serverError(let statusCode, let detail):
            return detail ?? "Server error (\(statusCode))"
        case .authenticationRequired:
            return "Authentication required"
        }
    }
}

// MARK: - Self-Hosted Local Registration

public struct EnsureSelfHostedLocalRegistrationRequest: Codable, Sendable {
    public let clientInstallationId: String
    public let runtimeAssistantId: String
    public let clientPlatform: String
    public let assistantVersion: String?

    enum CodingKeys: String, CodingKey {
        case clientInstallationId = "client_installation_id"
        case runtimeAssistantId = "runtime_assistant_id"
        case clientPlatform = "client_platform"
        case assistantVersion = "assistant_version"
    }
}

public struct EnsureSelfHostedLocalRegistrationResponse: Codable, Sendable {
    public let assistant: SelfHostedAssistantInfo
    public let registration: SelfHostedRegistrationInfo
    public let assistantApiKey: String?

    enum CodingKeys: String, CodingKey {
        case assistant
        case registration
        case assistantApiKey = "assistant_api_key"
    }
}

public struct SelfHostedAssistantInfo: Codable, Sendable {
    public let id: String
    public let name: String?
}

public struct SelfHostedRegistrationInfo: Codable, Sendable {
    public let clientInstallationId: String
    public let runtimeAssistantId: String
    public let clientPlatform: String

    enum CodingKeys: String, CodingKey {
        case clientInstallationId = "client_installation_id"
        case runtimeAssistantId = "runtime_assistant_id"
        case clientPlatform = "client_platform"
    }
}

public struct ReprovisionSelfHostedLocalApiKeyRequest: Codable, Sendable {
    public let clientInstallationId: String
    public let runtimeAssistantId: String
    public let clientPlatform: String
    public let assistantVersion: String?

    enum CodingKeys: String, CodingKey {
        case clientInstallationId = "client_installation_id"
        case runtimeAssistantId = "runtime_assistant_id"
        case clientPlatform = "client_platform"
        case assistantVersion = "assistant_version"
    }
}

public struct ReprovisionSelfHostedLocalApiKeyResponse: Codable, Sendable {
    public let assistant: SelfHostedAssistantInfo
    public let provisioning: SelfHostedProvisioningInfo
}

public struct SelfHostedProvisioningInfo: Codable, Sendable {
    public let credentialName: String
    public let assistantApiKey: String
    public let rotated: Bool

    enum CodingKeys: String, CodingKey {
        case credentialName = "credential_name"
        case assistantApiKey = "assistant_api_key"
        case rotated
    }
}

// MARK: - Billing Models

public struct BillingSummaryResponse: Codable, Sendable {
    public let settled_balance_usd: String
    public let pending_compute_usd: String
    public let effective_balance_usd: String
    public let minimum_top_up_usd: String
    public let is_degraded: Bool
}

public struct TopUpCheckoutRequest: Codable, Sendable {
    public let amount_usd: String
    public let return_path: String
}

public struct TopUpCheckoutResponse: Codable, Sendable {
    public let checkout_url: String
}
