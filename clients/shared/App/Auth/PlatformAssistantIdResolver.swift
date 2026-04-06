import Foundation

/// Resolves the platform assistant ID for the current assistant, regardless of hosting mode.
///
/// - **Managed (cloud = "vellum")**: The lockfile `assistantId` IS the platform UUID — return it directly.
/// - **Self-hosted local**: The lockfile `assistantId` is a runtime slug (e.g., `vellum-cool-heron`),
///   not the platform UUID. The platform ID is persisted during bootstrap via `persist()` and looked
///   up by `(runtimeAssistantId, organizationId, userId)`.
///
/// Callers don't need to know the hosting mode — `resolve()` handles both cases.
public enum PlatformAssistantIdResolver {

    // MARK: - Key format

    /// Credential storage account name for the persisted platform assistant ID mapping.
    static func credentialStorageAccount(
        runtimeAssistantId: String,
        organizationId: String,
        userId: String
    ) -> String {
        "vellum_platform_id_\(runtimeAssistantId)_\(organizationId)_\(userId)"
    }

    // MARK: - Persist

    /// Persists the platform assistant ID for a self-hosted local assistant.
    ///
    /// Call this after `ensureSelfHostedLocalRegistration` returns the platform assistant ID
    /// during bootstrap. The mapping is scoped by runtime assistant ID, org ID, and user ID
    /// so switching accounts or orgs doesn't return stale IDs.
    @discardableResult
    public static func persist(
        platformAssistantId: String,
        runtimeAssistantId: String,
        organizationId: String,
        userId: String,
        credentialStorage: CredentialStorage
    ) -> Bool {
        let account = credentialStorageAccount(
            runtimeAssistantId: runtimeAssistantId,
            organizationId: organizationId,
            userId: userId
        )
        return credentialStorage.set(account: account, value: platformAssistantId)
    }

    /// Async variant that routes through the gateway when the storage supports it.
    @discardableResult
    public static func persistAsync(
        platformAssistantId: String,
        runtimeAssistantId: String,
        organizationId: String,
        userId: String,
        credentialStorage: CredentialStorage
    ) async -> Bool {
        let account = credentialStorageAccount(
            runtimeAssistantId: runtimeAssistantId,
            organizationId: organizationId,
            userId: userId
        )
        return await credentialStorage.setAsync(account: account, value: platformAssistantId)
    }

    // MARK: - Resolve

    /// Resolves the platform assistant ID for the current assistant.
    ///
    /// - For managed assistants (`isManaged == true`): returns the lockfile `assistantId` directly.
    /// - For self-hosted local assistants: looks up the persisted mapping in credential storage.
    /// - Returns `nil` if the assistant is local and no mapping has been persisted yet.
    public static func resolve(
        lockfileAssistantId: String,
        isManaged: Bool,
        organizationId: String?,
        userId: String?,
        credentialStorage: CredentialStorage
    ) -> String? {
        if isManaged {
            return lockfileAssistantId
        }

        guard let orgId = organizationId, let uid = userId else {
            return nil
        }

        let account = credentialStorageAccount(
            runtimeAssistantId: lockfileAssistantId,
            organizationId: orgId,
            userId: uid
        )
        return credentialStorage.get(account: account)
    }

    /// Async variant that routes through the gateway when the storage supports it.
    public static func resolveAsync(
        lockfileAssistantId: String,
        isManaged: Bool,
        organizationId: String?,
        userId: String?,
        credentialStorage: CredentialStorage
    ) async -> String? {
        if isManaged {
            return lockfileAssistantId
        }

        guard let orgId = organizationId, let uid = userId else {
            return nil
        }

        let account = credentialStorageAccount(
            runtimeAssistantId: lockfileAssistantId,
            organizationId: orgId,
            userId: uid
        )
        return await credentialStorage.getAsync(account: account)
    }

    // MARK: - Clear

    /// Removes the persisted platform assistant ID mapping for a specific scope.
    ///
    /// Call this when an account switch or logout invalidates the cached mapping.
    @discardableResult
    public static func clear(
        runtimeAssistantId: String,
        organizationId: String,
        userId: String,
        credentialStorage: CredentialStorage
    ) -> Bool {
        let account = credentialStorageAccount(
            runtimeAssistantId: runtimeAssistantId,
            organizationId: organizationId,
            userId: userId
        )
        return credentialStorage.delete(account: account)
    }
}
