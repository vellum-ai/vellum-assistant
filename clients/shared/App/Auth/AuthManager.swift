#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif
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
    private static let callbackScheme = "vellum-assistant"
    private var webAuthSession: ASWebAuthenticationSession?

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
        state = .loading
        errorMessage = nil

        guard await SessionTokenManager.getTokenAsync() != nil else {
            state = .unauthenticated
            return
        }

        var lastError: Error?
        for attempt in 1...3 {
            if Task.isCancelled { return }
            do {
                let response = try await authService.getSession(timeout: 10)
                if response.status == 200, response.meta?.is_authenticated != false, let user = response.data?.user {
                    state = .authenticated(user)
                    await resolveOrganizationIdAfterAuth()
                    return
                } else {
                    // Server authoritatively rejected the session —
                    // no retry, drop straight to unauthenticated.
                    state = .unauthenticated
                    return
                }
            } catch is CancellationError {
                // Task was cancelled (app backgrounded, view dismissed, etc).
                // Do not mutate state — the caller is tearing down or will
                // re-invoke. Leaving state alone avoids spurious logout UI.
                return
            } catch {
                lastError = error
                log.warning("Session check attempt \(attempt)/3 failed: \(error.localizedDescription, privacy: .public)")
                if attempt < 3 {
                    try? await Task.sleep(nanoseconds: 2_000_000_000) // 2 seconds between retries
                    if Task.isCancelled { return }
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
            let stateParam = generateRandomString(length: 32)
            let returnTo = "/accounts/native/callback?state=\(stateParam)"
            var allowedReturnToChars = CharacterSet.urlQueryAllowed
            allowedReturnToChars.remove(charactersIn: "?=&+")
            guard let encodedReturnTo = returnTo.addingPercentEncoding(withAllowedCharacters: allowedReturnToChars) else {
                throw AuthServiceError.invalidURL
            }
            let loginURLString = "\(VellumEnvironment.resolvedWebURL)/account/login?returnTo=\(encodedReturnTo)"
            guard let loginURL = URL(string: loginURLString) else {
                throw AuthServiceError.invalidURL
            }

            let callbackURL = try await performWebAuth(url: loginURL, callbackScheme: Self.callbackScheme)

            guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                  let sessionToken = components.queryItems?.first(where: { $0.name == "session_token" })?.value,
                  let returnedState = components.queryItems?.first(where: { $0.name == "state" })?.value else {
                throw AuthServiceError.authCallbackFailed("Missing session token or state in callback.")
            }

            guard returnedState == stateParam else {
                throw AuthServiceError.authCallbackFailed("Invalid state parameter.")
            }

            await SessionTokenManager.setTokenAsync(sessionToken)

            // Validate the session and populate user state
            let session = try await authService.getSession()
            if session.status == 200, session.meta?.is_authenticated != false, let user = session.data?.user {
                state = .authenticated(user)
                log.info("Login completed via Django auth flow for user \(user.id ?? user.email ?? "unknown", privacy: .public)")
                await resolveOrganizationIdAfterAuth()
            } else {
                log.error("Session validation after Django auth flow did not return authenticated user. status=\(session.status, privacy: .public)")
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
        #if os(macOS)
        LockfileAssistant.setActiveAssistantId(nil)
        #endif
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

    private func generateRandomString(length: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: length)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
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
        #if os(macOS)
        NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
        #elseif os(iOS)
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first(where: { $0.isKeyWindow }) ?? ASPresentationAnchor()
        #endif
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
