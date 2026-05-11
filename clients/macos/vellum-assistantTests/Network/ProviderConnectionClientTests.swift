import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - Mock

/// Spy implementation of ProviderConnectionClientProtocol for unit tests.
/// Records every call and returns pre-configured responses so tests can
/// assert both the call sequence and the returned values.
final class MockProviderConnectionClient: ProviderConnectionClientProtocol {

    // MARK: Spy: list
    var listCallCount = 0
    var listProviderArg: String??
    var listResponse: [ProviderConnection]? = []

    func listProviderConnections(provider: String?) async -> [ProviderConnection]? {
        listCallCount += 1
        listProviderArg = provider
        return listResponse
    }

    // MARK: Spy: get
    var getCallCount = 0
    var getNameArg: String?
    var getResponse: ProviderConnection? = nil

    func getProviderConnection(name: String) async -> ProviderConnection? {
        getCallCount += 1
        getNameArg = name
        return getResponse
    }

    // MARK: Spy: create
    var createCallCount = 0
    var createNameArg: String?
    var createProviderArg: String?
    var createAuthArg: ProviderConnectionAuth?
    var createLabelArg: String?
    var createStatusArg: ConnectionStatus?
    var createResponse: ProviderConnection? = nil

    func createProviderConnection(name: String, provider: String, auth: ProviderConnectionAuth, label: String?, status: ConnectionStatus?) async -> ProviderConnection? {
        createCallCount += 1
        createNameArg = name
        createProviderArg = provider
        createAuthArg = auth
        createLabelArg = label
        createStatusArg = status
        return createResponse
    }

    // MARK: Spy: update
    var updateCallCount = 0
    var updateNameArg: String?
    var updateAuthArg: ProviderConnectionAuth?
    var updateStatusArg: ConnectionStatus?
    var updateLabelArg: String??
    var updateResponse: ProviderConnection? = nil

    func updateProviderConnection(name: String, auth: ProviderConnectionAuth, status: ConnectionStatus?, label: String??) async -> ProviderConnection? {
        updateCallCount += 1
        updateNameArg = name
        updateAuthArg = auth
        updateStatusArg = status
        updateLabelArg = label
        return updateResponse
    }

    // MARK: Spy: delete
    var deleteCallCount = 0
    var deleteNameArg: String?
    var deleteResponse: ProviderConnectionDeleteResult = .deleted

    func deleteProviderConnection(name: String) async -> ProviderConnectionDeleteResult {
        deleteCallCount += 1
        deleteNameArg = name
        return deleteResponse
    }
}

// MARK: - Fixtures

private func makeConnection(
    name: String = "my-conn",
    provider: String = "anthropic",
    authType: String = "api_key",
    credential: String? = "sk-test",
    status: ConnectionStatus = .active,
    label: String? = nil
) -> ProviderConnection {
    ProviderConnection(
        name: name,
        provider: provider,
        auth: ProviderConnectionAuth(type: authType, credential: credential),
        status: status,
        label: label,
        createdAt: 0,
        updatedAt: 0
    )
}

// MARK: - Tests

/// Verifies the generated `ProviderConnection` Codable conformance keeps the
/// macOS app working against daemons that predate the `status` field. Mixed-
/// version setups must default missing `status` to `.active` rather than
/// throwing `keyNotFound` and stranding the Providers UI.
final class ProviderConnectionDecodingTests: XCTestCase {

    private func decode(_ jsonString: String) throws -> ProviderConnection {
        let data = jsonString.data(using: .utf8)!
        return try JSONDecoder().decode(ProviderConnection.self, from: data)
    }

    func testDecodesStatusWhenPresent() throws {
        let conn = try decode("""
        {
          "name": "my-conn",
          "provider": "anthropic",
          "auth": { "type": "api_key", "credential": "credential/anthropic/api_key" },
          "status": "disabled",
          "createdAt": 1,
          "updatedAt": 2
        }
        """)
        XCTAssertEqual(conn.status, .disabled)
    }

    func testDefaultsToActiveWhenStatusKeyMissing() throws {
        let conn = try decode("""
        {
          "name": "my-conn",
          "provider": "anthropic",
          "auth": { "type": "api_key", "credential": "credential/anthropic/api_key" },
          "createdAt": 1,
          "updatedAt": 2
        }
        """)
        XCTAssertEqual(conn.status, .active)
    }

    func testDefaultsToActiveWhenStatusIsExplicitNull() throws {
        let conn = try decode("""
        {
          "name": "my-conn",
          "provider": "anthropic",
          "auth": { "type": "api_key", "credential": "credential/anthropic/api_key" },
          "status": null,
          "createdAt": 1,
          "updatedAt": 2
        }
        """)
        XCTAssertEqual(conn.status, .active)
    }
}

@MainActor
final class ProviderConnectionClientTests: XCTestCase {

    private var mock: MockProviderConnectionClient!

    override func setUp() {
        super.setUp()
        mock = MockProviderConnectionClient()
    }

    override func tearDown() {
        mock = nil
        super.tearDown()
    }

    // MARK: - list

    func testListReturnsEmptyWhenClientReturnsEmpty() async {
        mock.listResponse = []
        let result = await mock.listProviderConnections(provider: nil)
        XCTAssertEqual(result?.count, 0)
        XCTAssertEqual(mock.listCallCount, 1)
        XCTAssertNil(mock.listProviderArg as Any? as? String)
    }

    func testListReturnsConnectionsWhenClientReturnsPopulated() async {
        let conn = makeConnection()
        mock.listResponse = [conn]
        let result = await mock.listProviderConnections(provider: nil)
        XCTAssertEqual(result?.count, 1)
        XCTAssertEqual(result?.first?.name, "my-conn")
    }

    func testListPassesProviderFilter() async {
        mock.listResponse = []
        _ = await mock.listProviderConnections(provider: "openai")
        XCTAssertEqual(mock.listProviderArg as? String, "openai")
    }

    func testListReturnsNilOnNetworkError() async {
        mock.listResponse = nil
        let result = await mock.listProviderConnections(provider: nil)
        XCTAssertNil(result)
    }

    // MARK: - get

    func testGetReturnsConnectionOnSuccess() async {
        let conn = makeConnection(name: "target-conn")
        mock.getResponse = conn
        let result = await mock.getProviderConnection(name: "target-conn")
        XCTAssertEqual(result?.name, "target-conn")
        XCTAssertEqual(mock.getNameArg, "target-conn")
    }

    func testGetReturnsNilOn404() async {
        mock.getResponse = nil
        let result = await mock.getProviderConnection(name: "missing")
        XCTAssertNil(result)
    }

    // MARK: - create

    func testCreateReturnsConnectionOnSuccess() async {
        let conn = makeConnection(name: "new-conn")
        mock.createResponse = conn
        let auth = ProviderConnectionAuth(type: "api_key", credential: "sk-test")
        let result = await mock.createProviderConnection(name: "new-conn", provider: "anthropic", auth: auth, label: nil, status: nil)
        XCTAssertEqual(result?.name, "new-conn")
        XCTAssertEqual(mock.createNameArg, "new-conn")
        XCTAssertEqual(mock.createProviderArg, "anthropic")
        XCTAssertEqual(mock.createAuthArg?.type, "api_key")
        XCTAssertEqual(mock.createAuthArg?.credential, "sk-test")
    }

    func testCreateReturnsNilOn409NameConflict() async {
        mock.createResponse = nil
        let auth = ProviderConnectionAuth(type: "api_key", credential: "sk-test")
        let result = await mock.createProviderConnection(name: "existing", provider: "anthropic", auth: auth, label: nil, status: nil)
        XCTAssertNil(result, "nil return models 409 name conflict")
    }

    func testCreateReturnsNilOn400InvalidAuth() async {
        mock.createResponse = nil
        let auth = ProviderConnectionAuth(type: "api_key", credential: "")
        let result = await mock.createProviderConnection(name: "conn", provider: "anthropic", auth: auth, label: nil, status: nil)
        XCTAssertNil(result, "nil return models 400 invalid auth")
    }

    // MARK: - update

    func testUpdateReturnsConnectionOnSuccess() async {
        let conn = makeConnection(name: "conn")
        mock.updateResponse = conn
        let auth = ProviderConnectionAuth(type: "api_key", credential: "sk-new")
        let result = await mock.updateProviderConnection(name: "conn", auth: auth, status: nil, label: nil)
        XCTAssertEqual(result?.name, "conn")
        XCTAssertEqual(mock.updateNameArg, "conn")
        XCTAssertEqual(mock.updateAuthArg?.credential, "sk-new")
    }

    func testUpdateReturnsNilOn404() async {
        mock.updateResponse = nil
        let auth = ProviderConnectionAuth(type: "api_key", credential: "sk-x")
        let result = await mock.updateProviderConnection(name: "missing", auth: auth, status: nil, label: nil)
        XCTAssertNil(result)
    }

    // MARK: - delete

    func testDeleteReturnsDeletedOnSuccess() async {
        mock.deleteResponse = .deleted
        let result = await mock.deleteProviderConnection(name: "conn")
        guard case .deleted = result else {
            XCTFail("Expected .deleted, got \(result)")
            return
        }
        XCTAssertEqual(mock.deleteNameArg, "conn")
    }

    func testDeleteReturnsNotFoundOn404() async {
        mock.deleteResponse = .notFound
        let result = await mock.deleteProviderConnection(name: "missing")
        guard case .notFound = result else {
            XCTFail("Expected .notFound, got \(result)")
            return
        }
    }

    func testDeleteReturnsConflictWithReferencedByOn409() async {
        mock.deleteResponse = .conflict(referencedBy: ["profile-a", "profile-b"])
        let result = await mock.deleteProviderConnection(name: "locked")
        guard case .conflict(let refs) = result else {
            XCTFail("Expected .conflict, got \(result)")
            return
        }
        XCTAssertEqual(refs, ["profile-a", "profile-b"])
    }
}
