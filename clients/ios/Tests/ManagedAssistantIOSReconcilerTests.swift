#if canImport(UIKit)
import XCTest
@testable import VellumAssistantShared
@testable import vellum_assistant_ios

/// Exercises the post-authentication reconciliation path that restores
/// the iOS managed-connection identifiers after logout → re-login (LUM-1069).
@MainActor
final class ManagedAssistantIOSReconcilerTests: XCTestCase {

    private var defaults: UserDefaults!
    private var defaultsSuiteName: String!

    override func setUp() {
        super.setUp()
        // Isolated in-memory defaults so tests cannot leak state into the real
        // app's identifiers or into each other.
        defaultsSuiteName = "ManagedAssistantIOSReconcilerTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: defaultsSuiteName)
        defaults.removePersistentDomain(forName: defaultsSuiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        defaults = nil
        defaultsSuiteName = nil
        super.tearDown()
    }

    // MARK: - Fixtures

    private func makeReconciler(
        activeAssistant: PlatformAssistantResult = .notFound,
        bootstrapOutcome: ManagedBootstrapOutcome = .createdNew(
            PlatformAssistant(id: "asst-new")
        ),
        platformBaseURL: String = "https://platform.test.example.com",
        rebuildClientCalled: @escaping @MainActor () -> Void = {}
    ) -> (ManagedAssistantIOSReconciler, StubAuthLookup, StubBootstrap) {
        let auth = StubAuthLookup(activeAssistant: activeAssistant)
        let bootstrap = StubBootstrap(outcome: bootstrapOutcome)
        let reconciler = ManagedAssistantIOSReconciler(
            authLookup: auth,
            bootstrap: bootstrap,
            defaults: defaults,
            platformBaseURL: platformBaseURL,
            rebuildClient: rebuildClientCalled
        )
        return (reconciler, auth, bootstrap)
    }

    // MARK: - Happy-path short-circuit

    func test_reconcile_shortCircuitsWhenIdentifiersAlreadyPersisted() async throws {
        defaults.set("asst-existing", forKey: UserDefaultsKeys.managedAssistantId)
        defaults.set("https://platform.example.com", forKey: UserDefaultsKeys.managedPlatformBaseURL)

        var rebuildCount = 0
        let (reconciler, auth, bootstrap) = makeReconciler(
            rebuildClientCalled: { rebuildCount += 1 }
        )

        let result = try await reconciler.reconcile()

        XCTAssertNil(result, "Short-circuit path returns nil")
        XCTAssertEqual(rebuildCount, 0, "rebuildClient is not invoked when identifiers are present")
        XCTAssertEqual(auth.resolveOrganizationIdCallCount, 0, "No network call when identifiers are present")
        XCTAssertEqual(bootstrap.ensureCallCount, 0, "No bootstrap call when identifiers are present")
    }

    // MARK: - Logout → re-login restoration

    func test_reconcile_restoresIdentifiersAfterLogoutClearedThem() async throws {
        // Simulate the AuthManager.logout() cleanup — identifiers were present,
        // then removed. Reconcile must restore them.
        defaults.removeObject(forKey: UserDefaultsKeys.managedAssistantId)
        defaults.removeObject(forKey: UserDefaultsKeys.managedPlatformBaseURL)

        var rebuildCount = 0
        let restoredAssistant = PlatformAssistant(id: "asst-restored")
        let (reconciler, _, _) = makeReconciler(
            activeAssistant: .found(restoredAssistant),
            platformBaseURL: "https://platform.example.com",
            rebuildClientCalled: { rebuildCount += 1 }
        )

        let result = try await reconciler.reconcile()

        XCTAssertEqual(result?.id, "asst-restored")
        XCTAssertEqual(defaults.string(forKey: UserDefaultsKeys.managedAssistantId), "asst-restored")
        XCTAssertEqual(defaults.string(forKey: UserDefaultsKeys.managedPlatformBaseURL), "https://platform.example.com")
        XCTAssertEqual(rebuildCount, 1)
    }

    // MARK: - Active-assistant happy path

    func test_reconcile_usesActiveAssistantWhenFound() async throws {
        let active = PlatformAssistant(id: "asst-active")
        var rebuildCount = 0
        let (reconciler, auth, bootstrap) = makeReconciler(
            activeAssistant: .found(active),
            rebuildClientCalled: { rebuildCount += 1 }
        )

        let result = try await reconciler.reconcile()

        XCTAssertEqual(result?.id, "asst-active")
        XCTAssertEqual(auth.resolveOrganizationIdCallCount, 1)
        XCTAssertEqual(auth.getActiveAssistantCallCount, 1)
        XCTAssertEqual(bootstrap.ensureCallCount, 0, "Bootstrap not called when an active assistant is returned")
        XCTAssertEqual(rebuildCount, 1)
    }

    // MARK: - Fallback to bootstrap

    func test_reconcile_fallsBackToBootstrapWhenNoActiveAssistant() async throws {
        let created = PlatformAssistant(id: "asst-created")
        let (reconciler, auth, bootstrap) = makeReconciler(
            activeAssistant: .notFound,
            bootstrapOutcome: .createdNew(created)
        )

        let result = try await reconciler.reconcile()

        XCTAssertEqual(result?.id, "asst-created")
        XCTAssertEqual(auth.getActiveAssistantCallCount, 1)
        XCTAssertEqual(bootstrap.ensureCallCount, 1)
        XCTAssertEqual(defaults.string(forKey: UserDefaultsKeys.managedAssistantId), "asst-created")
    }

    func test_reconcile_usesReusedExistingOutcomeFromBootstrap() async throws {
        let reused = PlatformAssistant(id: "asst-reused")
        let (reconciler, _, _) = makeReconciler(
            activeAssistant: .notFound,
            bootstrapOutcome: .reusedExisting(reused)
        )

        let result = try await reconciler.reconcile()

        XCTAssertEqual(result?.id, "asst-reused")
        XCTAssertEqual(defaults.string(forKey: UserDefaultsKeys.managedAssistantId), "asst-reused")
    }

    // MARK: - Force refresh

    func test_reconcile_forceRefreshIgnoresPersistedIdentifiers() async throws {
        defaults.set("asst-stale", forKey: UserDefaultsKeys.managedAssistantId)
        defaults.set("https://stale.example.com", forKey: UserDefaultsKeys.managedPlatformBaseURL)

        let fresh = PlatformAssistant(id: "asst-fresh")
        let (reconciler, auth, _) = makeReconciler(
            activeAssistant: .found(fresh),
            platformBaseURL: "https://platform.example.com"
        )

        let result = try await reconciler.reconcile(forceRefresh: true)

        XCTAssertEqual(result?.id, "asst-fresh")
        XCTAssertEqual(auth.resolveOrganizationIdCallCount, 1)
        XCTAssertEqual(defaults.string(forKey: UserDefaultsKeys.managedAssistantId), "asst-fresh")
        XCTAssertEqual(defaults.string(forKey: UserDefaultsKeys.managedPlatformBaseURL), "https://platform.example.com")
    }

    // MARK: - Error propagation

    func test_reconcile_propagatesResolveOrganizationIdError() async {
        let auth = StubAuthLookup(activeAssistant: .notFound)
        auth.resolveOrganizationIdError = TestError.boom
        let bootstrap = StubBootstrap(outcome: .createdNew(PlatformAssistant(id: "asst-x")))
        let reconciler = ManagedAssistantIOSReconciler(
            authLookup: auth,
            bootstrap: bootstrap,
            defaults: defaults,
            platformBaseURL: "https://platform.example.com",
            rebuildClient: {}
        )

        do {
            _ = try await reconciler.reconcile()
            XCTFail("Expected error to propagate")
        } catch {
            XCTAssertEqual(error as? TestError, .boom)
        }
        XCTAssertNil(defaults.string(forKey: UserDefaultsKeys.managedAssistantId))
    }
}

// MARK: - Stubs

@MainActor
private final class StubAuthLookup: ManagedAssistantActiveAssistantLookup {
    var organizationId = "org-test"
    var activeAssistant: PlatformAssistantResult
    var resolveOrganizationIdCallCount = 0
    var getActiveAssistantCallCount = 0
    var resolveOrganizationIdError: Error?

    init(activeAssistant: PlatformAssistantResult) {
        self.activeAssistant = activeAssistant
    }

    func resolveOrganizationId() async throws -> String {
        resolveOrganizationIdCallCount += 1
        if let resolveOrganizationIdError {
            throw resolveOrganizationIdError
        }
        return organizationId
    }

    func getActiveAssistant(organizationId: String) async throws -> PlatformAssistantResult {
        getActiveAssistantCallCount += 1
        return activeAssistant
    }
}

@MainActor
private final class StubBootstrap: ManagedAssistantBootstrapping {
    var outcome: ManagedBootstrapOutcome
    var ensureCallCount = 0

    init(outcome: ManagedBootstrapOutcome) {
        self.outcome = outcome
    }

    func ensureManagedAssistant(
        name: String?,
        description: String?,
        anthropicApiKey: String?
    ) async throws -> ManagedBootstrapOutcome {
        ensureCallCount += 1
        return outcome
    }
}

private enum TestError: Error, Equatable { case boom }
#endif
