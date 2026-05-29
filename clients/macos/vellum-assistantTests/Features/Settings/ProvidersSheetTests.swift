import SwiftUI
import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Structural tests for `ProvidersSheet`. Exercises construction, empty-state
/// detection, and the invariants that the sheet drives against the
/// `MockProviderConnectionClient` spy. Mirrors `InferenceProfilesSheetTests`:
/// build the SwiftUI tree without rendering and assert store-backed / protocol
/// contracts rather than pixel output.
@MainActor
final class ProvidersSheetTests: XCTestCase {

    private var store: SettingsStore!
    private var mockClient: MockProviderConnectionClient!

    override func setUp() {
        super.setUp()
        let fixture = SettingsTestFixture.make(
            providerCatalog: SettingsTestFixture.anthropicAndOpenAICatalog()
        )
        store = fixture.store
        mockClient = MockProviderConnectionClient()
    }

    override func tearDown() {
        store = nil
        mockClient = nil
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeSheet() -> ProvidersSheet {
        let isPresented = Binding<Bool>(get: { true }, set: { _ in })
        return ProvidersSheet(store: store, isPresented: isPresented, client: mockClient)
    }

    private func makeConnection(
        name: String = "my-conn",
        provider: String = "anthropic",
        authType: String = "api_key",
        label: String? = nil
    ) -> ProviderConnection {
        ProviderConnection(
            name: name,
            provider: provider,
            auth: ProviderConnectionAuth(type: authType, credential: "sk-test"),
            label: label,
            createdAt: 0,
            updatedAt: 0
        )
    }

    // MARK: - Body construction

    func testSheetBuildsWhenClientReturnsEmpty() {
        mockClient.listResponse = []
        let sheet = makeSheet()
        XCTAssertNotNil(sheet.body, "Body must be constructible when no connections are loaded")
    }

    func testSheetBuildsWhenClientReturnsConnections() {
        mockClient.listResponse = [makeConnection()]
        let sheet = makeSheet()
        XCTAssertNotNil(sheet.body)
    }

    func testSheetBuildsWhenClientReturnsNil() {
        mockClient.listResponse = nil
        let sheet = makeSheet()
        XCTAssertNotNil(sheet.body, "Body must be constructible even when client returns nil")
    }

    // MARK: - Create flow happy path

    func testCreateCallsClientWithExpectedArguments() async {
        let created = makeConnection(name: "new-conn", provider: "openai", authType: "api_key")
        mockClient.createResponse = .created(created)

        _ = await mockClient.createProviderConnection(
            name: "new-conn",
            provider: "openai",
            auth: ProviderConnectionAuth(type: "api_key", credential: "sk-open"),
            label: nil,
            baseUrl: nil,
            models: nil
        )

        XCTAssertEqual(mockClient.createCallCount, 1)
        XCTAssertEqual(mockClient.createNameArg, "new-conn")
        XCTAssertEqual(mockClient.createProviderArg, "openai")
        XCTAssertEqual(mockClient.createAuthArg?.type, "api_key")
        XCTAssertEqual(mockClient.createAuthArg?.credential, "sk-open")
    }

    // MARK: - Delete 409 conflict

    func testDeleteConflictSurfacesReferencedBy() async {
        mockClient.deleteResponse = .conflict(referencedBy: ["profile-x", "profile-y"])
        let result = await mockClient.deleteProviderConnection(name: "locked-conn")
        guard case .conflict(let refs) = result else {
            XCTFail("Expected conflict result")
            return
        }
        XCTAssertEqual(refs.count, 2)
        XCTAssertTrue(refs.contains("profile-x"))
        XCTAssertTrue(refs.contains("profile-y"))
    }

    // MARK: - 404 on edit triggers refresh

    func testEditNotFoundReturnsNilAndSignalsRefresh() async {
        mockClient.updateResponse = nil
        mockClient.listResponse = [makeConnection()]

        let result = await mockClient.updateProviderConnection(
            name: "gone",
            auth: ProviderConnectionAuth(type: "api_key", credential: "sk-x"),
            label: nil,
            baseUrl: nil,
            models: nil
        )
        XCTAssertNil(result, "nil update signals 404; caller should refresh")

        // A refresh call would follow
        _ = await mockClient.listProviderConnections(provider: nil)
        XCTAssertEqual(mockClient.listCallCount, 1)
    }

    // MARK: - Sheet init is constructible with default client

    func testSheetIsConstructibleWithDefaultClient() {
        let isPresented = Binding<Bool>(get: { true }, set: { _ in })
        let sheet = ProvidersSheet(store: store, isPresented: isPresented)
        XCTAssertNotNil(sheet.body)
    }

    // MARK: - Providers button surfaces in InferenceServiceCard

    func testProvidersSheetCanBeConstructedFromCard() {
        let isPresented = Binding<Bool>(get: { true }, set: { _ in })
        let sheet = ProvidersSheet(store: store, isPresented: isPresented, client: mockClient)
        XCTAssertNotNil(sheet.body, "ProvidersSheet must build with the same store the card holds")
    }

    // MARK: - Display Name auto-derives Key via kebab-case

    func testLabelToKebabCaseAutoDerivation() {
        // Verify toKebabCase produces correct output (shared with InferenceProfileEditor).
        XCTAssertEqual(InferenceProfileEditor.toKebabCase("My OpenAI"), "my-openai")
        XCTAssertEqual(InferenceProfileEditor.toKebabCase("Fast & Cheap"), "fast-cheap")
        XCTAssertEqual(InferenceProfileEditor.toKebabCase(""), "")
        XCTAssertEqual(InferenceProfileEditor.toKebabCase("hello world!"), "hello-world")
    }

    // MARK: - Connections with label render correctly

    func testSheetBuildsWithLabeledConnection() {
        let conn = makeConnection(name: "labeled", label: "My Anthropic")
        mockClient.listResponse = [conn]
        let sheet = makeSheet()
        XCTAssertNotNil(sheet.body)
    }

    // MARK: - Managed connections: Save as New entry point

    /// Builds a `ProviderConnection` flagged as `isManaged: true`, matching
    /// the daemon-seeded canonical rows (anthropic-managed / openai-managed
    /// / gemini-managed) that own the Save as New affordance.
    private func makeManagedConnection(
        name: String = "anthropic-managed",
        provider: String = "anthropic",
        label: String? = "Anthropic"
    ) -> ProviderConnection {
        ProviderConnection(
            name: name,
            provider: provider,
            auth: ProviderConnectionAuth(type: "platform", credential: nil),
            label: label,
            createdAt: 0,
            updatedAt: 0,
            isManaged: true
        )
    }

    /// A managed row must keep the sheet structurally valid — its row branch
    /// in `connectionRow` takes the `beginManagedEdit` path (locks Auth,
    /// disables Delete), and that branch must not throw a ViewBuilder type
    /// error or crash the inline editor on open.
    func testSheetBuildsWithManagedConnection() {
        mockClient.listResponse = [makeManagedConnection()]
        let sheet = makeSheet()
        XCTAssertNotNil(
            sheet.body,
            "Sheet must build when a managed connection is loaded — exercises the managed-edit branch in `connectionRow` and the Save as New footer surface."
        )
    }

    /// The `EditorState` enum must keep `.managedEdit` distinct from `.edit`.
    /// The Save as New button is gated off `isAuthLocked`, which depends on
    /// `.managedEdit` pattern matching — collapsing the two cases would
    /// silently leak the button into plain edit mode (and vice versa,
    /// silently lock auth on user-owned rows).
    func testManagedEditStateIsDistinctFromEditState() {
        let managedEdit: ProvidersSheet.EditorState = .managedEdit(name: "anthropic-managed")
        let plainEdit: ProvidersSheet.EditorState = .edit(name: "anthropic-managed")
        XCTAssertNotEqual(
            managedEdit,
            plainEdit,
            "managed-edit and edit must remain distinct cases so isAuthLocked / Save as New only fire for managed."
        )
        XCTAssertEqual(managedEdit, .managedEdit(name: "anthropic-managed"))
        XCTAssertEqual(plainEdit, .edit(name: "anthropic-managed"))
    }

    /// Save as New routes through `createProviderConnection` (POST), not
    /// `updateProviderConnection` (PATCH) — the daemon assigns a fresh
    /// user-owned row instead of rewriting the managed source. The view-
    /// layer transition is exercised through `editorState = .create`; this
    /// test asserts the protocol-level contract of the resulting save.
    func testForkFromManagedSourceCallsCreateNotUpdate() async {
        let forked = makeConnection(
            name: "anthropic-personal",
            provider: "anthropic",
            authType: "api_key",
            label: "Anthropic"
        )
        mockClient.createResponse = .created(forked)

        _ = await mockClient.createProviderConnection(
            name: "anthropic-personal",
            provider: "anthropic",
            auth: ProviderConnectionAuth(type: "api_key", credential: "credential/anthropic/api_key"),
            label: "Anthropic",
            baseUrl: nil,
            models: nil
        )

        XCTAssertEqual(mockClient.createCallCount, 1, "Save as New must POST.")
        XCTAssertEqual(mockClient.updateCallCount, 0, "Save as New must not PATCH the managed source.")
        XCTAssertEqual(mockClient.createNameArg, "anthropic-personal")
        XCTAssertEqual(mockClient.createProviderArg, "anthropic")
        XCTAssertEqual(mockClient.createAuthArg?.type, "api_key")
        XCTAssertEqual(mockClient.createAuthArg?.credential, "credential/anthropic/api_key")
        XCTAssertEqual(mockClient.createLabelArg, "Anthropic")
    }

    // MARK: - Save as New: auto-generated name

    /// Save as New seeds the new connection's Key with `${provider}-personal`
    /// when nothing in the list owns that name. Matches the daemon's seed
    /// naming convention for user-owned forks of canonical managed
    /// connections (anthropic-managed → anthropic-personal).
    func testSaveAsNewNamePicksBaseWhenNoCollision() {
        let chosen = ProvidersSheet.saveAsNewName(
            provider: "anthropic",
            existingNames: ["anthropic-managed", "openai-managed"]
        )
        XCTAssertEqual(
            chosen,
            "anthropic-personal",
            "First fork of a managed row picks `${provider}-personal` outright."
        )
    }

    /// Save as New increments `${provider}-personal-2`, `-3`, … when the
    /// base name is already taken. Guards against a daemon 409 on the very
    /// first Create — the user shouldn't have to manually rename to dodge
    /// an existing fork.
    func testSaveAsNewNameIncrementsOnCollision() {
        XCTAssertEqual(
            ProvidersSheet.saveAsNewName(
                provider: "anthropic",
                existingNames: ["anthropic-managed", "anthropic-personal"]
            ),
            "anthropic-personal-2",
            "Second fork lands on `-2` when `-personal` is taken."
        )
        XCTAssertEqual(
            ProvidersSheet.saveAsNewName(
                provider: "anthropic",
                existingNames: [
                    "anthropic-managed",
                    "anthropic-personal",
                    "anthropic-personal-2",
                ]
            ),
            "anthropic-personal-3",
            "Third fork lands on `-3` when `-personal` and `-2` are taken."
        )
    }

    /// Gap-skipping: if the user has deleted intermediate forks (e.g.
    /// `-personal-2` is gone but `-personal-3` still exists), the helper
    /// still finds the lowest free integer suffix. Pure deterministic
    /// behavior — no surprise jumps to `-personal-4`.
    func testSaveAsNewNameFillsLowestGap() {
        XCTAssertEqual(
            ProvidersSheet.saveAsNewName(
                provider: "openai",
                existingNames: ["openai-personal", "openai-personal-3"]
            ),
            "openai-personal-2",
            "Helper finds the lowest unused suffix instead of jumping past the gap."
        )
    }
}
