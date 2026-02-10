import Foundation
import Auth0
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "Auth0Manager")

@MainActor
final class Auth0Manager: ObservableObject {
    @Published var isAuthenticated = false

    private let credentialsManager: CredentialsManager

    private static let scopes = "openid profile email offline_access"

    init() {
        self.credentialsManager = CredentialsManager(authentication: Auth0.authentication())
        self.isAuthenticated = credentialsManager.canRenew()
    }

    // MARK: - Login

    func login() async throws {
        let credentials = try await Auth0
            .webAuth()
            .scope(Self.scopes)
            .start()

        _ = credentialsManager.store(credentials: credentials)
        isAuthenticated = true
        log.info("Login succeeded")
    }

    // MARK: - Logout

    func logout() async throws {
        try await Auth0
            .webAuth()
            .clearSession()

        _ = credentialsManager.clear()
        isAuthenticated = false
        log.info("Logout succeeded")
    }

    // MARK: - Token Access

    func getAccessToken() async throws -> String {
        let credentials = try await credentialsManager.credentials()
        return credentials.accessToken
    }
}
