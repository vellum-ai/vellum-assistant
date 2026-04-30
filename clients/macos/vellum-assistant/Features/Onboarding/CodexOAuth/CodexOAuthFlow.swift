import AppKit
import Foundation
import os

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "CodexOAuthFlow"
)

struct CodexCredentials: Codable, Equatable {
    let access: String
    let refresh: String
    let expiresAt: Date
    let accountId: String
}

enum CodexOAuthFlowError: Error, LocalizedError {
    case loopback(CodexOAuthLoopbackError)
    case browserOpenFailed
    case tokenExchangeFailed(status: Int, body: String)
    case malformedTokenResponse
    case missingAccountId

    var errorDescription: String? {
        switch self {
        case .loopback(let inner):
            return inner.errorDescription
        case .browserOpenFailed:
            return "Could not open the system browser for sign-in."
        case .tokenExchangeFailed(let status, let body):
            return "OAuth token exchange failed (HTTP \(status)): \(body.prefix(200))"
        case .malformedTokenResponse:
            return "OAuth token response was missing required fields."
        case .missingAccountId:
            return "Sign-in succeeded but no ChatGPT account is linked to this OpenAI login."
        }
    }
}

@MainActor
enum CodexOAuthFlow {
    private static let clientId = "app_EMoamEEZ73f0CkXaXp7hrann"
    private static let authorizeURL = "https://auth.openai.com/oauth/authorize"
    private static let tokenURL = "https://auth.openai.com/oauth/token"
    private static let redirectURI = "http://localhost:1455/auth/callback"
    private static let scope = "openid profile email offline_access"
    private static let originator = "vellum-assistant"
    private static let jwtAuthClaim = "https://api.openai.com/auth"
    private static let callbackTimeout: TimeInterval = 5 * 60

    static func login() async throws -> CodexCredentials {
        let pkce = PKCEHelper.generate()
        let state = PKCEHelper.randomState()

        let loopback = CodexOAuthLoopback(expectedState: state)

        let authorizeURL = try buildAuthorizeURL(challenge: pkce.challenge, state: state)

        guard NSWorkspace.shared.open(authorizeURL) else {
            loopback.stop()
            throw CodexOAuthFlowError.browserOpenFailed
        }

        log.info("Opened OpenAI Codex authorize URL in browser")

        let code: String
        do {
            code = try await loopback.waitForCallback(timeout: callbackTimeout)
        } catch let err as CodexOAuthLoopbackError {
            throw CodexOAuthFlowError.loopback(err)
        }

        return try await exchangeCodeForTokens(code: code, verifier: pkce.verifier)
    }

    // MARK: - Authorize URL

    private static func buildAuthorizeURL(challenge: String, state: String) throws -> URL {
        guard var components = URLComponents(string: authorizeURL) else {
            throw CodexOAuthFlowError.browserOpenFailed
        }
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "scope", value: scope),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "id_token_add_organizations", value: "true"),
            URLQueryItem(name: "codex_cli_simplified_flow", value: "true"),
            URLQueryItem(name: "originator", value: originator),
        ]
        guard let url = components.url else {
            throw CodexOAuthFlowError.browserOpenFailed
        }
        return url
    }

    // MARK: - Token Exchange

    private static func exchangeCodeForTokens(code: String, verifier: String) async throws -> CodexCredentials {
        guard let url = URL(string: tokenURL) else {
            throw CodexOAuthFlowError.tokenExchangeFailed(status: 0, body: "invalid token URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = formEncode([
            "grant_type": "authorization_code",
            "client_id": clientId,
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": redirectURI,
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let body = String(data: data, encoding: .utf8) ?? "<non-utf8 body>"
            throw CodexOAuthFlowError.tokenExchangeFailed(status: status, body: body)
        }

        guard
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let access = json["access_token"] as? String, !access.isEmpty,
            let refresh = json["refresh_token"] as? String, !refresh.isEmpty,
            let expiresIn = (json["expires_in"] as? NSNumber)?.doubleValue,
            expiresIn > 0
        else {
            throw CodexOAuthFlowError.malformedTokenResponse
        }

        guard let accountId = extractAccountId(accessToken: access) else {
            throw CodexOAuthFlowError.missingAccountId
        }

        return CodexCredentials(
            access: access,
            refresh: refresh,
            expiresAt: Date().addingTimeInterval(expiresIn),
            accountId: accountId
        )
    }

    // MARK: - JWT

    private static func extractAccountId(accessToken: String) -> String? {
        guard let payload = decodeJwtPayload(accessToken) else { return nil }
        guard let auth = payload[jwtAuthClaim] as? [String: Any] else { return nil }
        guard let id = auth["chatgpt_account_id"] as? String, !id.isEmpty else { return nil }
        return id
    }

    private static func decodeJwtPayload(_ token: String) -> [String: Any]? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        guard let data = base64URLDecode(String(parts[1])) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private static func base64URLDecode(_ string: String) -> Data? {
        var s = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        // Pad to multiple of 4.
        let remainder = s.count % 4
        if remainder > 0 {
            s.append(String(repeating: "=", count: 4 - remainder))
        }
        return Data(base64Encoded: s)
    }

    // MARK: - Form encoding

    private static func formEncode(_ params: [String: String]) -> Data {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "+&=")
        let pairs = params.map { key, value -> String in
            let k = key.addingPercentEncoding(withAllowedCharacters: allowed) ?? key
            let v = value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
            return "\(k)=\(v)"
        }
        return Data(pairs.joined(separator: "&").utf8)
    }
}
