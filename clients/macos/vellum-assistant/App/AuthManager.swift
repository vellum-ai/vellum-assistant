import AppKit
import AuthenticationServices
import CryptoKit
import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AuthManager")

enum AuthState {
    case loading
    case unauthenticated
    case authenticated(AllauthUser)
}

@Observable
@MainActor
final class AuthManager {
    var state: AuthState = .loading
    var isSubmitting = false
    var errorMessage: String?

    private let authService = AuthService.shared
    // Always use the production scheme for auth callbacks regardless of build
    // configuration. ASWebAuthenticationSession intercepts the redirect in-process
    // so it won't conflict with a production install, and WorkOS only needs one
    // whitelisted redirect URI.
    private static let callbackScheme = "vellum-assistant"
    private var webAuthSession: ASWebAuthenticationSession?

    var isAuthenticated: Bool {
        if case .authenticated = state { return true }
        return false
    }

    var currentUser: AllauthUser? {
        if case .authenticated(let user) = state { return user }
        return nil
    }

    func checkSession() async {
        state = .loading
        errorMessage = nil

        guard await SessionTokenManager.getTokenAsync() != nil else {
            state = .unauthenticated
            return
        }

        do {
            let response = try await authService.getSession()
            if response.status == 200, response.meta?.is_authenticated != false, let user = response.data?.user {
                state = .authenticated(user)
            } else {
                state = .unauthenticated
            }
        } catch {
            log.error("Session check failed: \(error.localizedDescription)")
            state = .unauthenticated
        }
    }

    func startWorkOSLogin() async {
        isSubmitting = true
        errorMessage = nil

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

            if response.status == 200, response.meta?.is_authenticated != false, let user = response.data?.user {
                state = .authenticated(user)
            } else {
                errorMessage = "Authentication was not completed. Please try again."
            }
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            log.info("User cancelled WorkOS login")
        } catch {
            errorMessage = error.localizedDescription
        }
        isSubmitting = false
    }

    func logout() async {
        do {
            _ = try await authService.logout()
        } catch {
            log.error("Logout request failed: \(error.localizedDescription)")
        }
        await SessionTokenManager.deleteTokenAsync()
        state = .unauthenticated
        errorMessage = nil
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

final class WebAuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = WebAuthPresentationContext()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
    }
}

extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
