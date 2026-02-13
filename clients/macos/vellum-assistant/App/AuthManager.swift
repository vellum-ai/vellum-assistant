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

enum AuthFlow: Equatable {
    case login
    case signup
    case verifyEmail
    case providerSignup
    case forgotPassword
}

@Observable
@MainActor
final class AuthManager {
    var state: AuthState = .loading
    var currentFlow: AuthFlow = .login
    var isSubmitting = false
    var errorMessage: String?
    var providers: [ProviderConfig] = []

    var pendingVerificationEmail: String?
    var pendingProviderSignupEmail: String?
    var pendingProviderSignupUsername: String?

    private let authService = AuthService.shared
    private static let callbackScheme = "vellum-assistant"

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

        guard SessionTokenManager.getToken() != nil else {
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

    func login(email: String, password: String) async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            let response = try await authService.login(email: email, password: password)
            handleAuthResponse(response)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signup(email: String, username: String, password: String) async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            let response = try await authService.signup(email: email, username: username, password: password)
            handleAuthResponse(response)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func verifyEmail(key: String) async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            let response = try await authService.verifyEmail(key: key)
            if response.status == 200, let user = response.data?.user {
                state = .authenticated(user)
            } else if response.status == 401 {
                currentFlow = .login
            } else {
                errorMessage = response.errors?.first?.message ?? "Email verification failed."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func completeProviderSignup(email: String, username: String) async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            let response = try await authService.completeProviderSignup(email: email, username: username)
            handleAuthResponse(response)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func requestPasswordReset(email: String) async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            _ = try await authService.requestPasswordReset(email: email)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func startOIDCLogin(provider: ProviderConfig) async {
        guard let clientId = provider.client_id,
              let discoveryURL = provider.openid_configuration_url else {
            errorMessage = "Provider \(provider.id) is not configured for OIDC login."
            return
        }

        isSubmitting = true
        errorMessage = nil

        do {
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
                URLQueryItem(name: "prompt", value: "login"),
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
                provider: provider.id,
                process: "login",
                clientId: clientId,
                idToken: tokenResponse.id_token,
                accessToken: tokenResponse.access_token
            )
            handleAuthResponse(response)
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            log.info("User cancelled OIDC login")
            isSubmitting = false
        } catch {
            errorMessage = error.localizedDescription
            isSubmitting = false
        }
    }

    func logout() async {
        do {
            _ = try await authService.logout()
        } catch {
            log.error("Logout request failed: \(error.localizedDescription)")
        }
        SessionTokenManager.deleteToken()
        state = .unauthenticated
        currentFlow = .login
        errorMessage = nil
    }

    func loadConfig() async {
        do {
            let config = try await authService.getConfig()
            let oidcProviders = (config.data?.socialaccount?.providers ?? []).filter {
                $0.client_id != nil && $0.openid_configuration_url != nil
            }
            providers = oidcProviders
        } catch {
            log.error("Failed to load auth config: \(error.localizedDescription)")
        }
    }

    private func handleAuthResponse(_ response: AllauthResponse<SessionData>) {
        if response.status == 200, response.meta?.is_authenticated != false, let user = response.data?.user {
            state = .authenticated(user)
            return
        }

        if response.status == 401, let flows = response.data?.flows {
            if let pending = flows.first(where: { $0.is_pending == true }) {
                switch pending.id {
                case "provider_signup":
                    currentFlow = .providerSignup
                case "verify_email":
                    currentFlow = .verifyEmail
                case "login":
                    currentFlow = .login
                case "signup":
                    currentFlow = .signup
                default:
                    currentFlow = .login
                }
                return
            }
        }

        if let firstError = response.errors?.first {
            errorMessage = firstError.message
        } else if response.status >= 400 {
            errorMessage = "Authentication failed. Please try again."
        }
    }

    private func performWebAuth(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { callbackURL, error in
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
            session.start()
        }
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
