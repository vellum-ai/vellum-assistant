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

    /// Logs in via app-held WorkOS User Management PKCE.
    ///
    /// The client drives WorkOS directly (rather than letting Django run the
    /// OAuth flow server-side) and exchanges the resulting WorkOS access
    /// token for its own Django session token:
    ///   1. Discover the WorkOS UM client id from the platform's headless
    ///      config.
    ///   2. Generate an S256 PKCE pair + CSRF `state`.
    ///   3. Authorize at WorkOS via `ASWebAuthenticationSession`, receiving
    ///      the one-time code on `{scheme}://auth/callback`.
    ///   4. Exchange the code at WorkOS as a PUBLIC client → `access_token`.
    ///   5. Exchange the access token for a Django session token via allauth's
    ///      headless `auth/provider/token` endpoint, then store it.
    public func startWorkOSLogin() async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            // 1. Discover the token-auth WorkOS UM client id. During the
            // coexistence window two `workos-oidc` entries are listed; the
            // OAuth2 one (provider_token flow, no OIDC discovery URL) is the
            // usable one.
            let config = try await authService.getConfig()
            let providers = config.data?.socialaccount?.providers ?? []
            guard let clientID = WorkOSPKCE.selectWorkosClientId(providers) else {
                throw WorkOSPKCE.PkceError.noTokenAuthProvider
            }

            // 2. PKCE pair + CSRF state.
            guard let pkce = WorkOSPKCE.generatePkcePair(),
                  let stateParam = WorkOSPKCE.randomBase64URLString(byteCount: 32) else {
                throw WorkOSPKCE.PkceError.randomGenerationFailed
            }

            // 3. Authorize at WorkOS. The redirect URI is the app's custom
            // scheme from CFBundleURLSchemes (vellum-assistant in prod,
            // vellum-assistant-{env} otherwise). performWebAuth keeps its
            // non-ephemeral session so existing Safari IdP cookies are reused.
            let redirectURI = WorkOSPKCE.redirectURI(scheme: Self.callbackScheme)
            let authURL = try WorkOSPKCE.buildAuthorizeURL(
                clientID: clientID,
                redirectURI: redirectURI,
                challenge: pkce.challenge,
                state: stateParam
            )

            let callbackURL = try await performWebAuth(url: authURL, callbackScheme: Self.callbackScheme)
            let code = try WorkOSPKCE.extractCode(from: callbackURL, expectedState: stateParam)

            // 4. Exchange the code at WorkOS as a public client (no secret).
            let accessToken = try await authService.exchangeWorkOSCode(
                clientID: clientID,
                code: code,
                verifier: pkce.verifier
            )

            // 5. Exchange the WorkOS access token for a Django session token.
            let sessionToken = try await authService.exchangeWorkOSAccessTokenForSession(
                clientID: clientID,
                accessToken: accessToken
            )

            await SessionTokenManager.setTokenAsync(sessionToken)

            let session = try await authService.getSession()
            if session.status == 200, session.meta?.is_authenticated != false, let user = session.data?.user {
                state = .authenticated(user)
                log.info("Login completed via WorkOS PKCE for user \(user.id ?? user.email ?? "unknown", privacy: .public)")
                await resolveOrganizationIdAfterAuth()
                await postAuthenticationHook?()
            } else {
                log.error("Session validation after WorkOS PKCE did not return authenticated user. status=\(session.status, privacy: .public)")
                errorMessage = "Authentication was not completed. Please try again."
            }
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            log.info("User cancelled login")
        } catch {
            log.error("Login failed: baseURL=\(VellumEnvironment.resolvedPlatformURL, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
            errorMessage = "Unable to sign in. Please try again."
        }
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
            // Rely on Apple's default (non-ephemeral) browser session so the
            // user's existing IdP cookies in Safari are visible during auth —
            // otherwise Google re-prompts for credentials on every login,
            // defeating SSO inside ASWebAuthenticationSession. (The iOS
            // counterpart in vellum-assistant-platform opts into ephemeral
            // mode separately for a platform-specific signup_closed loop
            // that this client does not have.)
            //
            // https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/prefersephemeralwebbrowsersession
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
