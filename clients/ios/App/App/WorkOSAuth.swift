import CryptoKit
import Foundation

/// Pure helpers for PKCE flow against WorkOS.
enum WorkOSAuth {
    static let apiBaseURL = "https://api.workos.com"
    static let providerId = "workos"
    static let scope = "openid profile email"

    /// base64url without padding (RFC 7636 §A).
    static func base64URLEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// 32 random bytes, base64url-encoded. Returns nil on RNG failure,
    /// which callers must treat as fatal.
    static func generateCodeVerifier() -> String? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess
        else { return nil }
        return base64URLEncode(Data(bytes))
    }

    static func codeChallenge(forVerifier verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return base64URLEncode(Data(digest))
    }

    /// Build the WorkOS authorize URL.
    /// `prompt` is deliberately omitted for parity with other clients,
    /// but we current spawn an ephemeral session anyway.
    static func buildAuthorizeURL(
        clientId: String,
        redirectURI: String,
        challenge: String,
        state: String,
        loginHint: String?,
        intent: String?
    ) -> URL? {
        var components = URLComponents(string: "\(apiBaseURL)/user_management/authorize")
        var items = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: scope),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "provider", value: "authkit"),
        ]
        if let loginHint = nonEmpty(loginHint) {
            items.append(URLQueryItem(name: "login_hint", value: loginHint))
        }
        if intent == "signup" {
            items.append(URLQueryItem(name: "screen_hint", value: "sign-up"))
        }
        components?.queryItems = items
        return components?.url
    }

    /// Pick the OAuth2 WorkOS provider's client id.
    /// During the transition window, two entries share the `workos-oidc` id.
    /// The usable one has token auth and no OIDC discovery URL.
    /// Returns nil if there is no compatible token provider, in which
    /// callers should surface a clear error.
    static func selectClientId(fromConfig data: Data) -> String? {
        guard
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let dataObj = root["data"] as? [String: Any],
            let social = dataObj["socialaccount"] as? [String: Any],
            let providers = social["providers"] as? [[String: Any]]
        else { return nil }

        for provider in providers {
            // `as? String == nil` treats an absent key, JSON null (NSNull
            // under JSONSerialization), and any non-string alike as "no
            // discovery URL" — i.e. the OAuth2 provider, not legacy OIDC.
            guard (provider["openid_configuration_url"] as? String) == nil,
                  let flows = provider["flows"] as? [String],
                  flows.contains("provider_token"),
                  let clientId = provider["client_id"] as? String
            else { continue }
            return clientId
        }
        return nil
    }

    static func authenticateRequestBody(clientId: String, code: String, verifier: String) -> Data? {
        try? JSONSerialization.data(withJSONObject: [
            "client_id": clientId,
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
        ])
    }

    static func accessToken(fromAuthenticate data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return nonEmpty(json["access_token"] as? String)
    }

    static func providerTokenRequestBody(clientId: String, accessToken: String) -> Data? {
        try? JSONSerialization.data(withJSONObject: [
            "provider": providerId,
            "process": "login",
            "token": ["client_id": clientId, "access_token": accessToken],
        ])
    }

    static func sessionToken(fromProviderToken data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let meta = json["meta"] as? [String: Any]
        else { return nil }
        return nonEmpty(meta["session_token"] as? String)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value, !value.isEmpty else { return nil }
        return value
    }
}
