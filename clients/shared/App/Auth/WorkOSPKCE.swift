import CryptoKit
import Foundation

/// App-held PKCE login against WorkOS User Management. Pure helpers
/// (Foundation + CryptoKit only, isolation-typecheckable + unit-testable);
/// `AuthManager` drives the network/UI. Mirrors the Electron implementation.
public enum WorkOSPKCE {
    public static let apiBaseURL = "https://api.workos.com"
    /// allauth provider `id` for the WorkOS OAuth2 provider — `workos`, even
    /// though its `sub_id` (the config entry's id) is `workos-oidc`.
    public static let providerID = "workos"
    public static let scope = "openid profile email"
    public static let callbackPath = "/auth/callback"

    // MARK: - PKCE

    public struct PkcePair: Sendable, Equatable {
        public let verifier: String
        public let challenge: String

        public init(verifier: String, challenge: String) {
            self.verifier = verifier
            self.challenge = challenge
        }
    }

    public enum PkceError: LocalizedError {
        case randomGenerationFailed
        case invalidURL
        case configFetchFailed(String)
        case noTokenAuthProvider
        case callbackMissingComponents
        case callbackError(String)
        case callbackMissingState
        case stateMismatch
        case callbackMissingCode
        case codeExchangeFailed(String)
        case sessionExchangeFailed(String)

        public var errorDescription: String? {
            switch self {
            case .randomGenerationFailed:
                return "Failed to generate secure random bytes."
            case .invalidURL:
                return "Invalid URL."
            case .configFetchFailed(let detail):
                return "Failed to fetch auth config: \(detail)"
            case .noTokenAuthProvider:
                return "Platform does not advertise a token-auth WorkOS provider; cannot start PKCE login."
            case .callbackMissingComponents:
                return "Missing callback URL components."
            case .callbackError(let detail):
                return "Auth error: \(detail)"
            case .callbackMissingState:
                return "Callback missing state."
            case .stateMismatch:
                return "State mismatch — possible CSRF."
            case .callbackMissingCode:
                return "Callback missing authorization code."
            case .codeExchangeFailed(let detail):
                return "WorkOS code exchange failed: \(detail)"
            case .sessionExchangeFailed(let detail):
                return "Session exchange failed: \(detail)"
            }
        }
    }

    /// S256 PKCE pair: verifier = 32 random bytes, challenge =
    /// base64url(SHA256(verifier)). Returns `nil` on RNG failure (fatal —
    /// PKCE is the sole defense against an intercepted code).
    public static func generatePkcePair() -> PkcePair? {
        guard let verifier = randomBase64URLString(byteCount: 32) else { return nil }
        let challengeData = Data(SHA256.hash(data: Data(verifier.utf8)))
        return PkcePair(verifier: verifier, challenge: base64URLEncode(challengeData))
    }

    /// `byteCount` cryptographically-random bytes, base64url-encoded without
    /// padding. Returns `nil` on RNG failure.
    public static func randomBase64URLString(byteCount: Int) -> String? {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { return nil }
        return base64URLEncode(Data(bytes))
    }

    /// base64url without padding. Inlined to keep the module self-contained.
    private static func base64URLEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: - Headless config provider selection

    /// One entry of `data.socialaccount.providers` in the headless config.
    public struct ProviderEntry: Codable, Sendable {
        public let id: String
        public let name: String?
        public let client_id: String?
        public let flows: [String]?
        public let openid_configuration_url: String?
    }

    public struct SocialAccountConfig: Codable, Sendable {
        public let providers: [ProviderEntry]?
    }

    public struct ConfigData: Codable, Sendable {
        public let socialaccount: SocialAccountConfig?
    }

    /// Headless `GET /_allauth/app/v1/config` envelope.
    public struct ConfigResponse: Codable, Sendable {
        public let data: ConfigData?
    }

    /// Pick the OAuth2 WorkOS client id from the headless config. During the
    /// coexistence window two entries share the `workos-oidc` id; the usable
    /// one has token auth and no OIDC discovery URL. `nil` if none.
    public static func selectWorkosClientId(_ providers: [ProviderEntry]) -> String? {
        providers.first {
            $0.openid_configuration_url == nil
                && ($0.flows ?? []).contains("provider_token")
                && $0.client_id != nil
        }?.client_id
    }

    /// Build the `GET {platformOrigin}/_allauth/app/v1/config` URL.
    public static func configURL(platformOrigin: String) -> URL? {
        guard var components = URLComponents(string: platformOrigin) else { return nil }
        components.path = "/_allauth/app/v1/config"
        components.query = nil
        components.fragment = nil
        return components.url
    }

    // MARK: - Authorize URL

    /// Build the WorkOS UM authorize URL.
    public static func buildAuthorizeURL(
        clientID: String,
        redirectURI: String,
        challenge: String,
        state: String
    ) throws -> URL {
        guard var components = URLComponents(string: "\(apiBaseURL)/user_management/authorize") else {
            throw PkceError.invalidURL
        }
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: scope),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            // No `prompt`: lets the browser's existing IdP session be reused.
            URLQueryItem(name: "provider", value: "authkit"),
        ]
        guard let url = components.url else { throw PkceError.invalidURL }
        return url
    }

    /// Custom-scheme redirect URI, e.g. `vellum-assistant://auth/callback`
    /// (`scheme` comes from the caller's `CFBundleURLSchemes`, per build).
    public static func redirectURI(scheme: String) -> String {
        "\(scheme)://\(callbackPath.dropFirst())"
    }

    // MARK: - Callback parsing

    /// Validate the callback URL and extract the one-time authorization code.
    /// Verifies `state` against `expectedState` (CSRF defense) and surfaces a
    /// returned `error` param ahead of a missing-state error.
    public static func extractCode(from callbackURL: URL, expectedState: String) throws -> String {
        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              let queryItems = components.queryItems else {
            throw PkceError.callbackMissingComponents
        }

        if let authError = queryItems.first(where: { $0.name == "error" })?.value, !authError.isEmpty {
            throw PkceError.callbackError(authError)
        }

        guard let returnedState = queryItems.first(where: { $0.name == "state" })?.value else {
            throw PkceError.callbackMissingState
        }
        guard returnedState == expectedState else {
            throw PkceError.stateMismatch
        }
        guard let code = queryItems.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
            throw PkceError.callbackMissingCode
        }
        return code
    }

    // MARK: - Token-exchange request builders

    /// POST body for the WorkOS public-client code exchange at
    /// `/user_management/authenticate`. No secret, no API key.
    public static func codeExchangeBody(clientID: String, code: String, verifier: String) -> [String: Any] {
        [
            "client_id": clientID,
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
        ]
    }

    public static func codeExchangeURL() -> URL? {
        URL(string: "\(apiBaseURL)/user_management/authenticate")
    }

    /// POST body for the allauth headless provider-token exchange at
    /// `/_allauth/app/v1/auth/provider/token`.
    public static func sessionExchangeBody(clientID: String, accessToken: String) -> [String: Any] {
        [
            "provider": providerID,
            "process": "login",
            "token": [
                "client_id": clientID,
                "access_token": accessToken,
            ],
        ]
    }

    public static func sessionExchangeURL(platformOrigin: String) -> URL? {
        guard var components = URLComponents(string: platformOrigin) else { return nil }
        components.path = "/_allauth/app/v1/auth/provider/token"
        components.query = nil
        components.fragment = nil
        return components.url
    }

    // MARK: - Response parsing

    /// Extract `access_token` from the WorkOS authenticate response body.
    public static func parseAccessToken(_ data: Data) throws -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["access_token"] as? String,
              !token.isEmpty else {
            throw PkceError.codeExchangeFailed("response contained no access token")
        }
        return token
    }

    /// Extract `meta.session_token` from the allauth provider-token response.
    public static func parseSessionToken(_ data: Data) throws -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let meta = json["meta"] as? [String: Any],
              let token = meta["session_token"] as? String,
              !token.isEmpty else {
            throw PkceError.sessionExchangeFailed("response contained no session token")
        }
        return token
    }
}
