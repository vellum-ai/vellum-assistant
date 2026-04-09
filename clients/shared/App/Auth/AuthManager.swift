#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif
import AuthenticationServices
import CryptoKit
import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AuthManager")

public enum AuthState {
    case loading
    case unauthenticated
    case authenticated(AllauthUser)
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

    public func checkSession() async {
        state = .loading
        errorMessage = nil

        guard await SessionTokenManager.getTokenAsync() != nil else {
            state = .unauthenticated
            return
        }

        var lastError: Error?
        for attempt in 1...3 {
            guard !Task.isCancelled else { state = .unauthenticated; return }
            do {
                let response = try await authService.getSession(timeout: 10)
                if response.status == 200, response.meta?.is_authenticated != false, let user = response.data?.user {
                    state = .authenticated(user)
                    return
                } else {
                    // Server responded but session is invalid — no retry needed
                    state = .unauthenticated
                    return
                }
            } catch is CancellationError {
                state = .unauthenticated
                return
            } catch {
                if Task.isCancelled {
                    state = .unauthenticated
                    return
                }
                lastError = error
                log.warning("Session check attempt \(attempt)/3 failed: \(error.localizedDescription, privacy: .public)")
                if attempt < 3 {
                    try? await Task.sleep(nanoseconds: 2_000_000_000) // 2 seconds between retries
                    guard !Task.isCancelled else { state = .unauthenticated; return }
                }
            }
        }
        // All retries exhausted — network likely still unavailable
        log.error("Session check failed after 3 attempts: baseURL=\(self.authService.baseURL, privacy: .public) error=\(lastError?.localizedDescription ?? "unknown", privacy: .public)")
        state = .unauthenticated
    }

    public func startWorkOSLogin() async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            let config = try await authService.getConfig()
            guard let provider = config.data?.socialaccount?.providers?.first(where: { $0.id == "workos-oidc" }),
                  let clientId = provider.client_id,
                  let discoveryURL = provider.openid_configuration_url else {
                throw AuthServiceError.oidcDiscoveryFailed
            }

            let discovery = try await authService.fetchOIDCDiscovery(url: discoveryURL)
            guard let authEndpoint = discovery.authorization_endpoint,
                  let tokenEndpoint = discovery.token_endpoint else {
                throw AuthServiceError.oidcDiscoveryFailed
            }

            let codeVerifier = generateCodeVerifier()
            let codeChallenge = generateCodeChallenge(from: codeVerifier)
            let stateParam = generateRandomString(length: 32)
            let redirectURI = "\(Self.callbackScheme)://auth/callback"

            guard var components = URLComponents(string: authEndpoint) else {
                throw AuthServiceError.invalidURL
            }
            components.queryItems = [
                URLQueryItem(name: "response_type", value: "code"),
                URLQueryItem(name: "client_id", value: clientId),
                URLQueryItem(name: "redirect_uri", value: redirectURI),
                URLQueryItem(name: "scope", value: "openid profile email"),
                URLQueryItem(name: "state", value: stateParam),
                URLQueryItem(name: "code_challenge_method", value: "S256"),
                URLQueryItem(name: "code_challenge", value: codeChallenge),
            ]

            guard let authURL = components.url else {
                throw AuthServiceError.invalidURL
            }

            let callbackURL = try await performWebAuth(url: authURL, callbackScheme: Self.callbackScheme)

            guard let urlComponents = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                  let code = urlComponents.queryItems?.first(where: { $0.name == "code" })?.value,
                  let returnedState = urlComponents.queryItems?.first(where: { $0.name == "state" })?.value else {
                throw AuthServiceError.oidcTokenExchangeFailed("Missing authorization code in callback.")
            }

            guard returnedState == stateParam else {
                throw AuthServiceError.oidcTokenExchangeFailed("Invalid state parameter.")
            }

            let tokenResponse = try await authService.exchangeOIDCCode(
                tokenEndpoint: tokenEndpoint,
                clientId: clientId,
                code: code,
                codeVerifier: codeVerifier,
                redirectURI: redirectURI
            )

            let response = try await authService.authenticateWithProviderToken(
                provider: "workos-oidc",
                process: "login",
                clientId: clientId,
                idToken: tokenResponse.id_token,
                accessToken: tokenResponse.access_token
            )

            log.info(
                "Provider-token auth completed with platformURL=\(self.authService.baseURL, privacy: .public) status=\(response.status, privacy: .public) isAuthenticated=\(response.meta?.is_authenticated == true, privacy: .public) hasUser=\(response.data?.user != nil, privacy: .public)"
            )

            if response.status == 200, response.meta?.is_authenticated != false {
                if let user = response.data?.user {
                    state = .authenticated(user)
                    log.info("WorkOS login completed from provider-token response for user \(user.id ?? user.email ?? "unknown", privacy: .public)")
                } else {
                    log.info("Provider-token auth returned no user payload; validating session via auth/session")
                    let session = try await authService.getSession()
                    if session.status == 200, session.meta?.is_authenticated != false, let user = session.data?.user {
                        state = .authenticated(user)
                        log.info("WorkOS login completed after session revalidation for user \(user.id ?? user.email ?? "unknown", privacy: .public)")
                    } else {
                        log.error(
                            "Session revalidation after provider-token auth did not return an authenticated user. status=\(session.status, privacy: .public) isAuthenticated=\(session.meta?.is_authenticated == true, privacy: .public) hasUser=\(session.data?.user != nil, privacy: .public)"
                        )
                        errorMessage = "Authentication was not completed. Please try again."
                    }
                }
            } else {
                log.error(
                    "Provider-token auth did not complete authentication. status=\(response.status, privacy: .public) isAuthenticated=\(response.meta?.is_authenticated == true, privacy: .public)"
                )
                errorMessage = "Authentication was not completed. Please try again."
            }
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            log.info("User cancelled WorkOS login")
        } catch {
            log.error("WorkOS login failed: baseURL=\(self.authService.baseURL, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
            let bundlePath = Bundle.main.bundlePath
            let isTranslocated = bundlePath.contains("/AppTranslocation/")
            log.error("WorkOS login failed environment: bundlePath=\(bundlePath, privacy: .public) isTranslocated=\(isTranslocated, privacy: .public)")
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
            log.error("Logout request failed: baseURL=\(self.authService.baseURL, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
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

    private func generateCodeVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 64)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URLEncodedString()
    }

    private func generateCodeChallenge(from verifier: String) -> String {
        let data = Data(verifier.utf8)
        let hash = SHA256.hash(data: data)
        return Data(hash).base64URLEncodedString()
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
                    continuation.resume(throwing: AuthServiceError.oidcTokenExchangeFailed("No callback URL received."))
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
        if let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }) ?? NSApp.windows.first {
            return window
        }
        // Last resort: create a temporary window so the auth sheet has a valid anchor.
        let fallback = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1, height: 1), styleMask: [], backing: .buffered, defer: true)
        fallback.center()
        return fallback
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
