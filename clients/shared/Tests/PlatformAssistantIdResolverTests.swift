import XCTest
@testable import VellumAssistantShared

/// In-memory credential storage for testing.
/// Marked `@unchecked Sendable` because tests drive it single-threaded; the
/// `CredentialStorage` protocol requires `Sendable` for production impls.
private final class MockCredentialStorage: CredentialStorage, @unchecked Sendable {
    private var store: [String: String] = [:]

    func get(account: String) -> String? {
        store[account]
    }

    func set(account: String, value: String) -> Bool {
        store[account] = value
        return true
    }

    func delete(account: String) -> Bool {
        store.removeValue(forKey: account) != nil
    }
}

final class PlatformAssistantIdResolverTests: XCTestCase {

    private var storage: MockCredentialStorage!

    override func setUp() {
        super.setUp()
        storage = MockCredentialStorage()
    }

    // MARK: - Managed assistants

    func testResolveManagedAssistantReturnsLockfileIdDirectly() {
        let platformId = "platform-uuid-1234"
        let result = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: platformId,
            isManaged: true,
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )
        XCTAssertEqual(result, platformId)
    }

    func testResolveManagedAssistantIgnoresPersistedMapping() {
        // Even if a mapping is persisted, managed mode should return the lockfile ID directly.
        PlatformAssistantIdResolver.persist(
            platformAssistantId: "stale-platform-id",
            runtimeAssistantId: "managed-uuid",
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )

        let result = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: "managed-uuid",
            isManaged: true,
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )
        XCTAssertEqual(result, "managed-uuid")
    }

    func testResolveManagedAssistantWorksWithoutOrgOrUserId() {
        let result = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: "managed-uuid",
            isManaged: true,
            organizationId: nil,
            userId: nil,
            credentialStorage: storage
        )
        XCTAssertEqual(result, "managed-uuid")
    }

    // MARK: - Self-hosted local assistants

    func testResolveLocalAssistantReturnsPersistedMapping() {
        PlatformAssistantIdResolver.persist(
            platformAssistantId: "platform-uuid-5678",
            runtimeAssistantId: "vellum-cool-heron",
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )

        let result = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: "vellum-cool-heron",
            isManaged: false,
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )
        XCTAssertEqual(result, "platform-uuid-5678")
    }

    func testResolveLocalAssistantReturnsNilWhenNotPersisted() {
        let result = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: "vellum-cool-heron",
            isManaged: false,
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )
        XCTAssertNil(result)
    }

    func testResolveLocalAssistantReturnsNilWithoutOrgId() {
        PlatformAssistantIdResolver.persist(
            platformAssistantId: "platform-uuid-5678",
            runtimeAssistantId: "vellum-cool-heron",
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )

        let result = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: "vellum-cool-heron",
            isManaged: false,
            organizationId: nil,
            userId: "user-1",
            credentialStorage: storage
        )
        XCTAssertNil(result)
    }

    func testResolveLocalAssistantReturnsNilWithoutUserId() {
        PlatformAssistantIdResolver.persist(
            platformAssistantId: "platform-uuid-5678",
            runtimeAssistantId: "vellum-cool-heron",
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )

        let result = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: "vellum-cool-heron",
            isManaged: false,
            organizationId: "org-1",
            userId: nil,
            credentialStorage: storage
        )
        XCTAssertNil(result)
    }

    // MARK: - Account switch isolation

    func testDifferentOrgIdReturnsDifferentMapping() {
        PlatformAssistantIdResolver.persist(
            platformAssistantId: "platform-org-A",
            runtimeAssistantId: "vellum-cool-heron",
            organizationId: "org-A",
            userId: "user-1",
            credentialStorage: storage
        )
        PlatformAssistantIdResolver.persist(
            platformAssistantId: "platform-org-B",
            runtimeAssistantId: "vellum-cool-heron",
            organizationId: "org-B",
            userId: "user-1",
            credentialStorage: storage
        )

        let resultA = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: "vellum-cool-heron",
            isManaged: false,
            organizationId: "org-A",
            userId: "user-1",
            credentialStorage: storage
        )
        let resultB = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: "vellum-cool-heron",
            isManaged: false,
            organizationId: "org-B",
            userId: "user-1",
            credentialStorage: storage
        )

        XCTAssertEqual(resultA, "platform-org-A")
        XCTAssertEqual(resultB, "platform-org-B")
    }

    func testDifferentUserIdReturnsDifferentMapping() {
        PlatformAssistantIdResolver.persist(
            platformAssistantId: "platform-user-1",
            runtimeAssistantId: "vellum-cool-heron",
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )
        PlatformAssistantIdResolver.persist(
            platformAssistantId: "platform-user-2",
            runtimeAssistantId: "vellum-cool-heron",
            organizationId: "org-1",
            userId: "user-2",
            credentialStorage: storage
        )

        let result1 = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: "vellum-cool-heron",
            isManaged: false,
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )
        let result2 = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: "vellum-cool-heron",
            isManaged: false,
            organizationId: "org-1",
            userId: "user-2",
            credentialStorage: storage
        )

        XCTAssertEqual(result1, "platform-user-1")
        XCTAssertEqual(result2, "platform-user-2")
    }

    // MARK: - Clear

    func testClearRemovesPersistedMapping() {
        PlatformAssistantIdResolver.persist(
            platformAssistantId: "platform-uuid-5678",
            runtimeAssistantId: "vellum-cool-heron",
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )

        PlatformAssistantIdResolver.clear(
            runtimeAssistantId: "vellum-cool-heron",
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )

        let result = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: "vellum-cool-heron",
            isManaged: false,
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )
        XCTAssertNil(result)
    }

    func testClearDoesNotAffectOtherScopes() {
        PlatformAssistantIdResolver.persist(
            platformAssistantId: "platform-A",
            runtimeAssistantId: "vellum-cool-heron",
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )
        PlatformAssistantIdResolver.persist(
            platformAssistantId: "platform-B",
            runtimeAssistantId: "vellum-cool-heron",
            organizationId: "org-2",
            userId: "user-1",
            credentialStorage: storage
        )

        PlatformAssistantIdResolver.clear(
            runtimeAssistantId: "vellum-cool-heron",
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )

        // org-2 mapping should still be present
        let result = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: "vellum-cool-heron",
            isManaged: false,
            organizationId: "org-2",
            userId: "user-1",
            credentialStorage: storage
        )
        XCTAssertEqual(result, "platform-B")
    }

    // MARK: - Persist overwrites

    func testPersistOverwritesExistingMapping() {
        PlatformAssistantIdResolver.persist(
            platformAssistantId: "old-platform-id",
            runtimeAssistantId: "vellum-cool-heron",
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )
        PlatformAssistantIdResolver.persist(
            platformAssistantId: "new-platform-id",
            runtimeAssistantId: "vellum-cool-heron",
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )

        let result = PlatformAssistantIdResolver.resolve(
            lockfileAssistantId: "vellum-cool-heron",
            isManaged: false,
            organizationId: "org-1",
            userId: "user-1",
            credentialStorage: storage
        )
        XCTAssertEqual(result, "new-platform-id")
    }

    // MARK: - Bootstrap credential cleanup

    /// Verifies that clearBootstrapCredential removes the locally cached
    /// bootstrap credential for a runtime assistant.
    @MainActor
    func testClearBootstrapCredentialRemovesCachedKey() {
        // GIVEN a bootstrap credential is stored
        let assistantId = "vellum-cool-heron"
        let account = LocalAssistantBootstrapService.credentialAccount(for: assistantId)
        _ = storage.set(account: account, value: "some-api-key")
        XCTAssertNotNil(storage.get(account: account))

        // WHEN clearing the bootstrap credential
        let deleted = LocalAssistantBootstrapService.clearBootstrapCredential(
            runtimeAssistantId: assistantId,
            credentialStorage: storage
        )

        // THEN the credential is removed
        XCTAssertTrue(deleted)
        // AND the storage no longer contains the key
        XCTAssertNil(storage.get(account: account))
    }

    /// Verifies that clearBootstrapCredential is a no-op when no credential
    /// exists, matching the expected behavior during deregistration of an
    /// assistant that was never bootstrapped.
    @MainActor
    func testClearBootstrapCredentialNoOpWhenNothingStored() {
        // GIVEN no credential is stored for this assistant

        // WHEN clearing the bootstrap credential
        let deleted = LocalAssistantBootstrapService.clearBootstrapCredential(
            runtimeAssistantId: "vellum-nonexistent",
            credentialStorage: storage
        )

        // THEN the delete returns false (nothing to remove)
        XCTAssertFalse(deleted)
    }

    /// Verifies that clearBootstrapCredential only removes the targeted
    /// assistant's credential, leaving other assistants' credentials intact.
    @MainActor
    func testClearBootstrapCredentialDoesNotAffectOtherAssistants() {
        // GIVEN credentials are stored for two assistants
        let assistantA = "vellum-cool-heron"
        let assistantB = "vellum-swift-eagle"
        let accountA = LocalAssistantBootstrapService.credentialAccount(for: assistantA)
        let accountB = LocalAssistantBootstrapService.credentialAccount(for: assistantB)
        _ = storage.set(account: accountA, value: "key-a")
        _ = storage.set(account: accountB, value: "key-b")

        // WHEN clearing only assistant A's credential
        LocalAssistantBootstrapService.clearBootstrapCredential(
            runtimeAssistantId: assistantA,
            credentialStorage: storage
        )

        // THEN assistant A's credential is removed
        XCTAssertNil(storage.get(account: accountA))
        // AND assistant B's credential is still present
        XCTAssertEqual(storage.get(account: accountB), "key-b")
    }
}
