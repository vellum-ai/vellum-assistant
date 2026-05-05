import AppKit
import AuthenticationServices
import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AuthManager")

/// The four authoritative auth states.
///
/// `.validationFailed` distinguishes a transient session-validation failure
/// (network unreachable, server 5xx) from `.unauthenticated` (server
/// authoritatively rejected the session, or no session token on disk).
/// UI must treat `.validationFailed` as "reconnecting" — not as "logged out"
/// — because the token on disk may still be valid and the next successful
/// validation can restore `.authenticated` without a new login.
public enum AuthState {
    case loading
    case unauthenticated
    case authenticated(AllauthUser)
    case validationFailed(lastError: Error)
}

@Observable
@MainActor
public final class AuthManager {
    public var state: AuthState = .loading
    public var isSubmitting = false
    public var errorMessage: String?

    private let authService = AuthService.shared
    /// Read the URL scheme from the bundle's CFBundleURLTypes rather than
    /// hardcoding it. Each environment gets its own scheme at build time
    /// (e.g. vellum-assistant-dev, vellum-assistant-staging). Falls back
    /// to "vellum-assistant" if the plist entry is missing.
    private static let callbackScheme: String = {
        guard let urlTypes = Bundle.main.infoDictionary?["CFBundleURLTypes"] as? [[String: Any]],
              let schemes = urlTypes.first?["CFBundleURLSchemes"] as? [String],
              let scheme = schemes.first,
              !scheme.isEmpty,
              !scheme.contains("$")
        else {
            return "vellum-assistant"
        }
        return scheme
    }()
    private var webAuthSession: ASWebAuthenticationSession?

    /// Optional hook invoked after a successful authentication (both the fresh
    /// login flow and background session re-validation) once `state` has
    /// transitioned to `.authenticated` and `resolveOrganizationIdAfterAuth()`
    /// has completed.
    ///
    /// Platform shells set this to reconcile any platform-specific connection
    /// state that `logout()` may have cleared. On iOS this is used to restore
    /// the managed assistant identifiers in `UserDefaults` (`managed_assistant_id`,
    /// `managed_platform_base_url`) so `GatewayHTTPClient.resolveConnection()`
    /// can build a `ConnectionInfo` after logout → re-login. macOS does not set
    /// the hook because its reconciliation lives in
    /// `ManagedAssistantConnectionCoordinator` / `LockfileAssistant`.
    ///
    /// Hook failures are owned by the hook — the auth state transition is
    /// already committed by the time the hook runs.
    @ObservationIgnored
    public var postAuthenticationHook: (@MainActor @Sendable () async -> Void)?

    public init() {}

    public var isAuthenticated: Bool {
        if case .authenticated = state { return true }
        return false
    }

    public var isLoading: Bool {
        if case .loading = state { return true }
        return false
    }

    public var currentUser: AllauthUser? {
        if case .authenticated(let user) = state { return user }
        return nil
    }

    /// True when validation failed transiently despite a session token on
    /// disk. The user is still (probably) logged in — UI should show a
    /// "reconnecting" state, not a login button.
    public var isValidationFailed: Bool {
        if case .validationFailed = state { return true }
        return false
    }

    /// Last error recorded when validation failed transiently, for logging
    /// or optional user-facing display.
    public var lastValidationError: Error? {
        if case .validationFailed(let error) = state { return error }
        return nil
    }

    public func checkSession() async {
        // Snapshot the prior state so cancellation can restore it instead
        // of leaving the manager stuck in `.loading` — which would suppress
        // both login and logout UI until another successful check ran.
        let priorState = state
        state = .loading
        errorMessage = nil

        guard await SessionTokenManager.getTokenAsync() != nil else {
            state = .unauthenticated
            return
        }

        var lastError: Error?
        for attempt in 1...3 {
            if Task.isCancelled { state = priorState; return }
            do {
                let response = try await authService.getSession(timeout: 10)
                if response.status == 200, response.meta?.is_authenticated != false, let user = response.data?.user {
                    state = .authenticated(user)
                    await resolveOrganizationIdAfterAuth()
                    await postAuthenticationHook?()
                    return
                } else {
                    // Server authoritatively rejected the session —
                    // no retry, drop straight to unauthenticated.
                    state = .unauthenticated
                    return
                }
            } catch is CancellationError {
                // Task was cancelled (app backgrounded, view dismissed, etc).
                // Restore prior state so cancellation is invisible to UI.
                state = priorState
                return
            } catch {
                lastError = error
                log.warning("Session check attempt \(attempt)/3 failed: \(error.localizedDescription, privacy: .public)")
                if attempt < 3 {
                    try? await Task.sleep(nanoseconds: 2_000_000_000) // 2 seconds between retries
                    if Task.isCancelled { state = priorState; return }
                }
            }
        }
        // All retries exhausted with a session token on disk: treat as
        // transient validation failure, NOT as unauthenticated. The token
        // may still be valid; the next re-validation can recover.
        log.error("Session check failed after 3 attempts: baseURL=\(VellumEnvironment.resolvedPlatformURL, privacy: .public) error=\(lastError?.localizedDescription ?? "unknown", privacy: .public)")
        state = .validationFailed(lastError: lastError ?? AuthServiceError.networkError(URLError(.unknown)))
    }

    public func startWorkOSLogin() async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            guard let stateParam = generateRandomString(length: 32) else {
                throw AuthServiceError.authCallbackFailed("Failed to generate secure random state.")
            }

            // Build /accounts/native/start?state={state}. The server
            // determines the callback scheme from settings.ENVIRONMENT
            // — the client no longer sends it (ATL-454).
            guard var startComponents = URLComponents(string: VellumEnvironment.resolvedWebURL) else {
                throw AuthServiceError.invalidURL
            }
            startComponents.path = "/accounts/native/start"
            startComponents.queryItems = [URLQueryItem(name: "state", value: stateParam)]

            guard let loginURL = startComponents.url else {
                throw AuthServiceError.invalidURL
            }

            let callbackURL = try await performWebAuth(url: loginURL, callbackScheme: Self.callbackScheme)

            guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                  let queryItems = components.queryItems else {
                throw AuthServiceError.authCallbackFailed("Missing callback URL components.")
            }

            let returnedState = queryItems.first(where: { $0.name == "state" })?.value

            if let authError = queryItems.first(where: { $0.name == "error" })?.value, !authError.isEmpty {
                throw AuthServiceError.authCallbackFailed("Auth error: \(authError)")
            }

            guard let returnedState else {
                throw AuthServiceError.authCallbackFailed("Callback missing state.")
            }

            guard returnedState == stateParam else {
                throw AuthServiceError.authCallbackFailed("State mismatch — possible CSRF.")
            }

            guard let code = queryItems.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
                throw AuthServiceError.authCallbackFailed("Callback missing authorization code.")
            }

            // Exchange the one-time code for a session token via POST.
            // The code is short-lived (30 s) and single-use (ATL-454).
            let sessionToken = try await exchangeCodeForSession(code: code)

            await SessionTokenManager.setTokenAsync(sessionToken)

            let session = try await authService.getSession()
            if session.status == 200, session.meta?.is_authenticated != false, let user = session.data?.user {
                state = .authenticated(user)
                log.info("Login completed via native auth flow for user \(user.id ?? user.email ?? "unknown", privacy: .public)")
                await resolveOrganizationIdAfterAuth()
                await postAuthenticationHook?()
            } else {
                log.error("Session validation after native auth flow did not return authenticated user. status=\(session.status, privacy: .public)")
                errorMessage = "Authentication was not completed. Please try again."
            }
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            log.info("User cancelled login")
        } catch {
            log.error("Login failed: baseURL=\(VellumEnvironment.resolvedPlatformURL, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
            errorMessage = "Unable to sign in. Please try again."
        }
    }

    /// Exchange a one-time authorization code for a session token.
    private func exchangeCodeForSession(code: String) async throws -> String {
        guard var exchangeComponents = URLComponents(string: VellumEnvironment.resolvedWebURL) else {
            throw AuthServiceError.invalidURL
        }
        exchangeComponents.path = "/accounts/native/exchange"

        guard let exchangeURL = exchangeComponents.url else {
            throw AuthServiceError.invalidURL
        }

        var request = URLRequest(url: exchangeURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code])

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw AuthServiceError.authCallbackFailed("Code exchange failed with status \(statusCode).")
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sessionToken = json["session_token"] as? String,
              !sessionToken.isEmpty else {
            throw AuthServiceError.authCallbackFailed("Code exchange returned invalid response.")
        }

        return sessionToken
    }

    /// Logs out by deleting the server session, clearing local tokens and
    /// persisted identifiers, and transitioning to `.unauthenticated`.
    ///
    /// Returns the error description if the HTTP DELETE to the session endpoint
    /// fails (e.g. server unreachable). The local cleanup always proceeds
    /// regardless. Does **not** set `errorMessage` — callers that need to
    /// surface the error (e.g. via a toast) should inspect the return value.
    @discardableResult
    public func logout() async -> String? {
        var logoutError: String?
        do {
            _ = try await authService.logout()
        } catch {
            log.error("Logout request failed: baseURL=\(VellumEnvironment.resolvedPlatformURL, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
            logoutError = error.localizedDescription
        }
        await SessionTokenManager.deleteTokenAsync()
        UserDefaults.standard.removeObject(forKey: "connectedOrganizationId")
        LockfileAssistant.setActiveAssistantId(nil)
        UserDefaults.standard.removeObject(forKey: "connectedAssistantId")
        UserDefaults.standard.removeObject(forKey: "managed_assistant_id")
        UserDefaults.standard.removeObject(forKey: "managed_platform_base_url")
        state = .unauthenticated
        return logoutError
    }

    /// Best-effort org resolution after a successful authentication.
    /// Failures are logged, not thrown: a transient network error here
    /// must not block the transition to `.authenticated`.
    private func resolveOrganizationIdAfterAuth() async {
        do {
            _ = try await authService.resolveOrganizationId()
        } catch {
            log.warning("Failed to resolve organization ID post-auth: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Generate a cryptographically random base64url string.
    /// Returns `nil` if the system RNG is unavailable — callers must
    /// treat this as a fatal condition since the state parameter is the
    /// sole CSRF defense on the auth callback.
    private func generateRandomString(length: Int) -> String? {
        var bytes = [UInt8](repeating: 0, count: length)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { return nil }
        return Data(bytes).base64URLEncodedString()
    }

    private func performWebAuth(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] callbackURL, error in
                self?.webAuthSession = nil
                if let error {
                    continuation.resume(throwing: error)
                } else if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else {
                    continuation.resume(throwing: AuthServiceError.authCallbackFailed("No callback URL received."))
                }
            }
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = WebAuthPresentationContext.shared
            self.webAuthSession = session
            session.start()
        }
    }
}

public final class WebAuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    public static let shared = WebAuthPresentationContext()

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
    }
}

extension Data {
    public func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
