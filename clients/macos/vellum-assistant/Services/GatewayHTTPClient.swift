import Foundation
import VellumAssistantShared

/// Authenticated HTTP client for platform assistant proxy requests.
///
/// All managed/remote assistant operations route through the platform at
/// `{baseURL}/v1/assistants/...` with session-token authentication.
/// This client consolidates the common request-building logic so callers
/// don't duplicate URL construction, auth headers, and org-id injection.
enum GatewayHTTPClient {

    /// Builds an authenticated `URLRequest` for the platform assistant proxy.
    ///
    /// - Parameters:
    ///   - baseURL: Platform base URL (e.g. `assistant.runtimeUrl ?? AuthService.shared.baseURL`).
    ///   - path: Path segment after `/v1/assistants/` (e.g. `"upgrade"` or `"{id}/healthz"`).
    ///     A trailing slash is appended automatically if missing.
    ///   - method: HTTP method (`"GET"`, `"POST"`, etc.).
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A configured `URLRequest`, or `nil` if no valid session token is available.
    static func buildRequest(
        baseURL: String,
        path: String,
        method: String,
        timeout: TimeInterval = 30
    ) -> URLRequest? {
        guard let token = SessionTokenManager.getToken(), !token.isEmpty else { return nil }
        let trailingSlash = path.hasSuffix("/") ? "" : "/"
        guard let url = URL(string: "\(baseURL)/v1/assistants/\(path)\(trailingSlash)") else { return nil }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue(token, forHTTPHeaderField: "X-Session-Token")

        if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId"), !orgId.isEmpty {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }

        return request
    }

    /// Convenience overload that resolves the base URL from a `LockfileAssistant`.
    ///
    /// Falls back to `AuthService.shared.baseURL` when the assistant has no explicit `runtimeUrl`.
    @MainActor
    static func buildRequest(
        assistant: LockfileAssistant,
        path: String,
        method: String,
        timeout: TimeInterval = 30
    ) -> URLRequest? {
        let baseURL = assistant.runtimeUrl ?? AuthService.shared.baseURL
        return buildRequest(baseURL: baseURL, path: path, method: method, timeout: timeout)
    }
}
