import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HealthCheckClient")

/// Checks assistant reachability.
///
/// Local assistants are checked by hitting their own gateway's `/readyz` endpoint
/// directly (unauthenticated). Remote/managed assistants route through
/// `GatewayHTTPClient` which handles URL resolution, authentication, and 401 retry.
@MainActor
public enum HealthCheckClient {

    /// Check whether the currently connected assistant is reachable.
    public static func isReachable(timeout: TimeInterval = 3) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "health",
                timeout: timeout,
                quiet: true
            )
            return response.isSuccess
        } catch {
            return false
        }
    }

    #if os(macOS)
    /// Resolves the health check URL for a local assistant.
    /// Returns `nil` when the gateway port cannot be determined from the lockfile.
    static func localHealthCheckURL(for assistant: LockfileAssistant) -> URL? {
        guard let port = assistant.gatewayPort else { return nil }
        return URL(string: "http://127.0.0.1:\(port)/readyz")
    }

    /// Check whether a specific assistant is reachable.
    ///
    /// Local assistants are checked by hitting their own gateway's `/readyz` endpoint
    /// directly (unauthenticated). Remote/managed assistants route through
    /// `GatewayHTTPClient` with full 401 retry and credential refresh behavior.
    public static func isReachable(for assistant: LockfileAssistant, timeout: TimeInterval = 3) async -> Bool {
        return await isReachable(for: assistant, timeout: timeout, session: .shared)
    }

    /// Internal entry point — accepts a `URLSession` for test injection.
    static func isReachable(for assistant: LockfileAssistant, timeout: TimeInterval = 3, session: URLSession) async -> Bool {
        if assistant.isRemote {
            do {
                let response = try await GatewayHTTPClient.get(
                    path: "health",
                    timeout: timeout,
                    quiet: true
                )
                return response.isSuccess
            } catch {
                return false
            }
        } else {
            guard let url = localHealthCheckURL(for: assistant) else { return false }
            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            request.timeoutInterval = timeout
            do {
                let (_, response) = try await session.data(for: request)
                if let httpResponse = response as? HTTPURLResponse {
                    return (200..<300).contains(httpResponse.statusCode)
                }
                return false
            } catch {
                return false
            }
        }
    }

    #endif
}
