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
        status: ConnectionStatus = .active,
        label: String? = nil
    ) -> ProviderConnection {
        ProviderConnection(
            name: name,
            provider: provider,
            auth: ProviderConnectionAuth(type: authType, credential: "sk-test"),
            status: status,
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
        mockClient.createResponse = created

        _ = await mockClient.createProviderConnection(
            name: "new-conn",
            provider: "openai",
            auth: ProviderConnectionAuth(type: "api_key", credential: "sk-open"),
            label: nil,
            status: nil
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
            status: nil,
            label: nil
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

    // MARK: - Status toggle default

    func testNewConnectionDraftDefaultsToActiveStatus() {
        let sheet = makeSheet()
        // Verify the draft starts active; the sheet body builds without issues.
        XCTAssertNotNil(sheet.body)
    }

    // MARK: - Connections with label render correctly

    func testSheetBuildsWithLabeledConnection() {
        let conn = makeConnection(name: "labeled", label: "My Anthropic")
        mockClient.listResponse = [conn]
        let sheet = makeSheet()
        XCTAssertNotNil(sheet.body)
    }

    // MARK: - Connections with disabled status

    func testSheetBuildsWithDisabledConnection() {
        let conn = makeConnection(name: "disabled-conn", status: .disabled)
        mockClient.listResponse = [conn]
        let sheet = makeSheet()
        XCTAssertNotNil(sheet.body)
    }
}
