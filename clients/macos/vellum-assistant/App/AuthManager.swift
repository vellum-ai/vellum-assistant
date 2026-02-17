import AppKit
import AuthenticationServices
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
            let callbackURI = "\(Self.callbackScheme)://auth/callback"
            let urlString = "\(authService.baseURL)/_allauth/browser/v1/auth/provider/redirect"

            guard var components = URLComponents(string: urlString) else {
                throw AuthServiceError.invalidURL
            }
            components.queryItems = [
                URLQueryItem(name: "provider", value: "workos-oidc"),
                URLQueryItem(name: "callback_url", value: callbackURI),
                URLQueryItem(name: "process", value: "login"),
            ]

            guard let authURL = components.url else {
                throw AuthServiceError.invalidURL
            }

            let resultURL = try await performWebAuth(url: authURL, callbackScheme: Self.callbackScheme)

            if let urlComponents = URLComponents(url: resultURL, resolvingAgainstBaseURL: false),
               let sessionToken = urlComponents.queryItems?.first(where: { $0.name == "session_token" })?.value {
                await SessionTokenManager.setTokenAsync(sessionToken)
            }

            await checkSession()

            if !isAuthenticated {
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

    private func performWebAuth(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] callbackURL, error in
                self?.webAuthSession = nil
                if let error {
                    continuation.resume(throwing: error)
                } else if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else {
                    continuation.resume(throwing: AuthServiceError.authFailed("No callback URL received."))
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
