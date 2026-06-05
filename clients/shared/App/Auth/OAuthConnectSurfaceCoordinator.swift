#if os(macOS)
import AuthenticationServices
import Foundation
import os

private let oauthSurfaceLog = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "OAuthConnectSurface"
)

private struct OAuthWebAuthStartError: LocalizedError {
    let errorDescription: String? = "Unable to start the authorization session."
}

public enum OAuthConnectSurfaceResult: Sendable {
    case connected(connection: OAuthConnectionEntry?)
    case cancelled
    case error(String)
}

@MainActor
public final class OAuthConnectSurfaceCoordinator {
    public static let shared = OAuthConnectSurfaceCoordinator()

    private let credentialStorage = SharedFileCredentialStorage()
    private var activeSession: ASWebAuthenticationSession?

    private init() {}

    public func connect(providerKey: String, providerLabel: String) async -> OAuthConnectSurfaceResult {
        do {
            let assistantId = try await resolvePlatformAssistantId()
            let baseline = connectionSignatures(
                await listConnectionsSafely(assistantId: assistantId),
                providerKey: providerKey
            )

            let response = try await PlatformOAuthService.shared.startOAuthConnect(
                provider: providerKey,
                assistantId: assistantId,
                redirectAfterConnect: "vellum-assistant://oauth/\(providerKey)/callback"
            )

            guard let connectURL = URL(string: response.connect_url) else {
                return .error("Invalid authorization URL.")
            }

            let callbackURL = try await performWebAuth(url: connectURL)
            let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)
            let oauthStatus = components?.queryItems?.first(where: { $0.name == "oauth_status" })?.value

            if oauthStatus == "connected" {
                if let connection = await waitForProviderConnection(
                    assistantId: assistantId,
                    providerKey: providerKey,
                    baselineSignatures: baseline
                ) {
                    return .connected(connection: connection)
                }
                return .error("\(providerLabel) connection finished, but no connected account was found.")
            }

            if oauthStatus == "error" {
                let errorCode = components?.queryItems?.first(where: { $0.name == "oauth_code" })?.value
                return .error(errorCode.map { "\(providerLabel) authorization failed: \($0)" } ?? "\(providerLabel) authorization failed.")
            }

            return .cancelled
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            oauthSurfaceLog.info("User cancelled OAuth connect for \(providerKey, privacy: .public)")
            return .cancelled
        } catch {
            oauthSurfaceLog.error("OAuth connect failed for \(providerKey, privacy: .public): \(error.localizedDescription)")
            return .error("Unable to connect \(providerLabel). Please try again.")
        }
    }

    private func performWebAuth(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "vellum-assistant") { [weak self] callbackURL, error in
                self?.activeSession = nil
                if let error {
                    continuation.resume(throwing: error)
                } else if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else {
                    continuation.resume(throwing: URLError(.badServerResponse))
                }
            }
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = WebAuthPresentationContext.shared
            activeSession = session
            guard session.start() else {
                activeSession = nil
                continuation.resume(throwing: OAuthWebAuthStartError())
                return
            }
        }
    }

    private func resolvePlatformAssistantId() async throws -> String {
        let connectedId = LockfileAssistant.loadActiveAssistantId()
            ?? UserDefaults.standard.string(forKey: "connectedAssistantId")
        guard let connectedId, !connectedId.isEmpty,
              let assistant = LockfileAssistant.loadByName(connectedId) else {
            throw PlatformAPIError.authenticationRequired
        }

        let orgId = UserDefaults.standard.string(forKey: AuthService.connectedOrganizationIdKey)
        let userId = try? await AuthService.shared.getSession().data?.user?.id

        if let resolved = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: assistant.assistantId,
            isManaged: assistant.isManaged,
            organizationId: orgId,
            userId: userId,
            credentialStorage: credentialStorage
        ) {
            return resolved
        }

        guard !assistant.isManaged else {
            throw PlatformAPIError.authenticationRequired
        }

        do {
            return try await LocalAssistantBootstrapService(credentialStorage: credentialStorage)
                .bootstrap(runtimeAssistantId: assistant.assistantId, clientPlatform: "macos")
        } catch {
            let refreshedUserId = (try? await AuthService.shared.getSession().data?.user?.id) ?? userId
            if let resolved = PlatformAssistantIdResolver.resolve(
                lockfileAssistantId: assistant.assistantId,
                isManaged: assistant.isManaged,
                organizationId: UserDefaults.standard.string(forKey: AuthService.connectedOrganizationIdKey) ?? orgId,
                userId: refreshedUserId,
                credentialStorage: credentialStorage
            ) {
                return resolved
            }
            throw error
        }
    }

    private func listConnectionsSafely(assistantId: String) async -> [OAuthConnectionEntry] {
        do {
            return try await PlatformOAuthService.shared.listConnections(assistantId: assistantId)
        } catch {
            return []
        }
    }

    private func waitForProviderConnection(
        assistantId: String,
        providerKey: String,
        baselineSignatures: [String: String]
    ) async -> OAuthConnectionEntry? {
        for attempt in 0..<8 {
            if attempt > 0 {
                try? await Task.sleep(for: .milliseconds(750))
            }
            let connections = await listConnectionsSafely(assistantId: assistantId)
            if let connection = findNewOrChangedProviderConnection(
                connections,
                providerKey: providerKey,
                baselineSignatures: baselineSignatures
            ) {
                return connection
            }
        }
        return nil
    }

    private func findNewOrChangedProviderConnection(
        _ connections: [OAuthConnectionEntry],
        providerKey: String,
        baselineSignatures: [String: String]
    ) -> OAuthConnectionEntry? {
        connections.first { connection in
            connection.provider == providerKey
                && connection.connected
                && baselineSignatures[connection.id] != connectionSignature(connection)
        }
    }

    private func connectionSignatures(
        _ connections: [OAuthConnectionEntry],
        providerKey: String
    ) -> [String: String] {
        Dictionary(
            uniqueKeysWithValues: connections
                .filter { $0.provider == providerKey }
                .map { ($0.id, connectionSignature($0)) }
        )
    }

    private func connectionSignature(_ connection: OAuthConnectionEntry) -> String {
        [
            connection.status,
            String(connection.connected),
            connection.account_label ?? "",
            (connection.scopes_granted ?? []).sorted().joined(separator: ","),
            connection.expires_at ?? ""
        ].joined(separator: "|")
    }
}
#endif
