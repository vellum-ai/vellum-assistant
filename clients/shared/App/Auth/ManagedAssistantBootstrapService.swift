import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ManagedAssistantBootstrap")

/// Outcome of a managed assistant bootstrap attempt.
public enum ManagedBootstrapOutcome: Sendable {
    case reusedExisting(PlatformAssistant)
    case createdNew(PlatformAssistant)
}

/// Errors that can occur during managed assistant bootstrapping.
public enum ManagedBootstrapError: LocalizedError, Sendable {
    case authenticationRequired
    case networkError(String)
    case serverError(statusCode: Int, detail: String?)
    case hatchFailed(String)
    case unexpectedResponse(String)
    case multipleOrganizations
    case accessRevoked(String)

    public var errorDescription: String? {
        switch self {
        case .authenticationRequired:
            return "Sign in required to set up your assistant"
        case .networkError(let message):
            return "Network error: \(message)"
        case .serverError(let statusCode, let detail):
            return detail ?? "Server error (\(statusCode))"
        case .hatchFailed(let message):
            return "Failed to create assistant: \(message)"
        case .unexpectedResponse(let message):
            return "Unexpected response format: \(message)"
        case .multipleOrganizations:
            return "Multiple organizations found. Multi-org support is not yet available — please contact support."
        case .accessRevoked(let id):
            return "Access to assistant \(id) has been revoked. Please sign out and sign in again to set up a new assistant."
        }
    }
}

/// Minimal protocol over `AuthService` used by `ManagedAssistantBootstrapService`.
/// Exists so tests can inject a mock without constructing a real `AuthService`.
@MainActor
public protocol ManagedAssistantBootstrapAuthServicing: AnyObject {
    func getOrganizations() async throws -> [PlatformOrganization]
    func resolveOrganizationId() async throws -> String
    func getAssistant(id: String, organizationId: String) async throws -> PlatformAssistantResult
    func listAssistants(organizationId: String, hosting: String?) async throws -> [PlatformAssistant]
    func hatchAssistant(
        organizationId: String,
        name: String?,
        description: String?,
        anthropicApiKey: String?
    ) async throws -> HatchAssistantResult
}

extension AuthService: ManagedAssistantBootstrapAuthServicing {}

#if os(macOS)
/// Minimal read/clear abstraction over the persisted active managed-assistant
/// id. Exists so tests can inject an in-memory fake and verify the bootstrap's
/// stale-ID clearing behavior without touching the developer's real lockfile.
@MainActor
public protocol ActiveAssistantIdStoring: AnyObject {
    func loadActiveAssistantId() -> String?
    func clearActiveAssistantId()
}

/// Production implementation backed by the real `LockfileAssistant` static API.
@MainActor
public final class LockfileActiveAssistantIdStore: ActiveAssistantIdStoring {
    public init() {}
    public func loadActiveAssistantId() -> String? {
        LockfileAssistant.loadActiveAssistantId()
    }
    public func clearActiveAssistantId() {
        _ = LockfileAssistant.setActiveAssistantId(nil)
    }
}
#endif

/// Orchestrates discovery or creation of a managed assistant on the platform.
///
/// The bootstrap flow on macOS:
/// 1. If a `connectedAssistantId` exists, fetch that specific assistant via GET /assistants/{id}/.
///    - 200: return it directly.
///    - 404 (deleted): clear the stale ID and fall through to step 2.
///    - 403 (access revoked): surface an `accessRevoked` error so the user knows.
/// 2. List platform assistants (GET /assistants/?hosting=platform) and reuse the first
///    result when the list is non-empty.
/// 3. Only when the list is empty (first-run UX), call POST /assistants/hatch/
///    (idempotent — returns existing or creates new).
/// 4. Any other error is surfaced as a typed `ManagedBootstrapError`.
///
/// On non-macOS platforms, steps 1–2 are skipped and hatch is called directly.
@MainActor
public final class ManagedAssistantBootstrapService {
    public static let shared = ManagedAssistantBootstrapService()

    private let authService: ManagedAssistantBootstrapAuthServicing
    #if os(macOS)
    private let activeAssistantIdStore: ActiveAssistantIdStoring
    #endif

    #if os(macOS)
    public init(
        authService: ManagedAssistantBootstrapAuthServicing? = nil,
        activeAssistantIdStore: ActiveAssistantIdStoring? = nil
    ) {
        self.authService = authService ?? AuthService.shared
        self.activeAssistantIdStore = activeAssistantIdStore ?? LockfileActiveAssistantIdStore()
    }
    #else
    public init(authService: ManagedAssistantBootstrapAuthServicing? = nil) {
        self.authService = authService ?? AuthService.shared
    }
    #endif

    public func ensureManagedAssistant(
        name: String? = nil,
        description: String? = nil,
        anthropicApiKey: String? = nil
    ) async throws -> ManagedBootstrapOutcome {
        let organizationId = try await resolveOrganizationId()

        // If we already have a selected managed assistant, retrieve it directly.
        #if os(macOS)
        if let connectedId = activeAssistantIdStore.loadActiveAssistantId() {
            log.info("Found connectedAssistantId: \(connectedId, privacy: .public), retrieving directly")
            let result: PlatformAssistantResult
            do {
                result = try await authService.getAssistant(id: connectedId, organizationId: organizationId)
            } catch let error as PlatformAPIError {
                throw mapPlatformError(error)
            }

            switch result {
            case .found(let assistant):
                log.info("Retrieved connected assistant: \(assistant.id, privacy: .public)")
                return .reusedExisting(assistant)
            case .notFound:
                log.warning("Connected assistant \(connectedId, privacy: .public) not found — clearing stale ID")
                activeAssistantIdStore.clearActiveAssistantId()
                // Fall through to list-then-hatch below.
            case .accessDenied:
                log.error("Access to connected assistant \(connectedId, privacy: .public) has been revoked")
                activeAssistantIdStore.clearActiveAssistantId()
                throw ManagedBootstrapError.accessRevoked(connectedId)
            }
        }

        // List platform assistants first; only fall through to hatch when the
        // list is empty (first-run UX). This avoids creating a duplicate
        // assistant when the user already has one on the platform.
        do {
            let existing = try await authService.listAssistants(
                organizationId: organizationId,
                hosting: "platform"
            )
            if let first = existing.first {
                log.info("Reusing existing platform assistant \(first.id, privacy: .public) from list")
                return .reusedExisting(first)
            }
            log.info("Platform assistant list returned empty, falling through to hatch")
        } catch let error as PlatformAPIError {
            throw mapPlatformError(error)
        }
        #endif

        // No selected assistant (or stale one was cleared) — hatch is idempotent
        // and will return the existing assistant if one exists.
        log.info("No stored assistant ID — calling idempotent hatch")
        let hatchResult: HatchAssistantResult
        do {
            hatchResult = try await authService.hatchAssistant(
                organizationId: organizationId,
                name: name,
                description: description,
                anthropicApiKey: anthropicApiKey
            )
        } catch let error as PlatformAPIError {
            throw mapPlatformError(error)
        }

        switch hatchResult {
        case .reusedExisting(let assistant):
            log.info("Hatch returned existing assistant: \(assistant.id, privacy: .public)")
            return .reusedExisting(assistant)
        case .createdNew(let assistant):
            log.info("Hatch created new assistant: \(assistant.id, privacy: .public)")
            return .createdNew(assistant)
        }
    }

    /// Polls `GET /v1/assistants/{id}/` until the assistant's status indicates it is
    /// fully provisioned, or until the timeout elapses.
    ///
    /// If the platform response omits the `status` field (older API versions), the
    /// assistant is assumed ready immediately for backward compatibility.
    public func awaitAssistantProvisioned(assistantId: String, timeout: TimeInterval = 120) async throws {
        guard let organizationId = UserDefaults.standard.string(forKey: "connectedOrganizationId") else {
            log.warning("No persisted organization ID — skipping provisioning poll")
            return
        }

        let start = CFAbsoluteTimeGetCurrent()

        while CFAbsoluteTimeGetCurrent() - start < timeout {
            do {
                let result = try await authService.getAssistant(id: assistantId, organizationId: organizationId)
                switch result {
                case .found(let assistant):
                    guard let status = assistant.status else {
                        log.info("Assistant \(assistantId, privacy: .public) has no status field — treating as ready")
                        return
                    }
                    if status == "active" {
                        log.info("Assistant \(assistantId, privacy: .public) status is active")
                        return
                    }
                    let terminalFailureStatuses: Set<String> = ["failed", "error", "terminated"]
                    if terminalFailureStatuses.contains(status) {
                        log.error("Assistant \(assistantId, privacy: .public) reached terminal failure status: \(status, privacy: .public)")
                        throw ManagedBootstrapError.hatchFailed("Assistant provisioning \(status)")
                    }
                    log.info("Assistant \(assistantId, privacy: .public) status: \(status, privacy: .public) — continuing to poll")
                case .notFound:
                    log.warning("Assistant \(assistantId, privacy: .public) not found during provisioning poll")
                case .accessDenied:
                    throw ManagedBootstrapError.accessRevoked(assistantId)
                }
            } catch let error as ManagedBootstrapError {
                throw error
            } catch let error as PlatformAPIError {
                throw mapPlatformError(error)
            } catch {
                log.warning("Provisioning poll failed for \(assistantId, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }

            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
        }

        log.warning("Provisioning poll timed out for \(assistantId, privacy: .public) after \(timeout)s — proceeding to health check")
    }

    /// Adapts `AuthService.resolveOrganizationId()` errors into the
    /// bootstrap's `ManagedBootstrapError` shape so existing UI messages
    /// keep working.
    private func resolveOrganizationId() async throws -> String {
        do {
            return try await authService.resolveOrganizationId()
        } catch AuthService.OrganizationResolutionError.noOrganizations {
            throw ManagedBootstrapError.serverError(statusCode: 0, detail: "No organizations found for this account")
        } catch AuthService.OrganizationResolutionError.multipleOrganizations {
            throw ManagedBootstrapError.multipleOrganizations
        } catch let error as PlatformAPIError {
            throw mapPlatformError(error)
        }
    }

    private func mapPlatformError(_ error: PlatformAPIError) -> ManagedBootstrapError {
        switch error {
        case .authenticationRequired:
            return .authenticationRequired
        case .accessDenied(let detail):
            return .hatchFailed(detail)
        case .networkError(let message):
            return .networkError(message)
        case .serverError(let statusCode, let detail):
            return .serverError(statusCode: statusCode, detail: detail)
        case .invalidURL:
            return .serverError(statusCode: 0, detail: "Invalid URL configuration")
        case .decodingError(let message):
            return .unexpectedResponse(message)
        case .notFound:
            return .serverError(statusCode: 404, detail: "Not found")
        }
    }
}
