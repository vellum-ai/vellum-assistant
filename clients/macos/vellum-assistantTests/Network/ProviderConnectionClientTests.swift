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
    var createBaseUrlArg: String?
    var createModelsArg: [ConnectionModel]?
    var createResponse: ProviderConnectionCreateResult = .error

    func createProviderConnection(name: String, provider: String, auth: ProviderConnectionAuth, label: String?, baseUrl: String?, models: [ConnectionModel]?) async -> ProviderConnectionCreateResult {
        createCallCount += 1
        createNameArg = name
        createProviderArg = provider
        createAuthArg = auth
        createLabelArg = label
        createBaseUrlArg = baseUrl
        createModelsArg = models
        return createResponse
    }

    // MARK: Spy: update
    var updateCallCount = 0
    var updateNameArg: String?
    var updateAuthArg: ProviderConnectionAuth?
    var updateLabelArg: String??
    var updateBaseUrlArg: String??
    var updateModelsArg: [ConnectionModel]??
    var updateResponse: ProviderConnection? = nil

    func updateProviderConnection(name: String, auth: ProviderConnectionAuth, label: String??, baseUrl: String??, models: [ConnectionModel]??) async -> ProviderConnection? {
        updateCallCount += 1
        updateNameArg = name
        updateAuthArg = auth
        updateLabelArg = label
        updateBaseUrlArg = baseUrl
        updateModelsArg = models
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

    // MARK: Spy: ChatGPT subscription auth
    var startChatgptAuthCallCount = 0
    var startChatgptAuthResponse: ChatgptAuthStartResult? = nil

    func startChatgptSubscriptionAuth() async -> ChatgptAuthStartResult? {
        startChatgptAuthCallCount += 1
        return startChatgptAuthResponse
    }

    var exchangeChatgptCallCount = 0
    var exchangeChatgptCodeArg: String?
    var exchangeChatgptStateArg: String?
    var exchangeChatgptResponse: Bool = false

    func exchangeChatgptAuthCode(code: String, state: String) async -> Bool {
        exchangeChatgptCallCount += 1
        exchangeChatgptCodeArg = code
        exchangeChatgptStateArg = state
        return exchangeChatgptResponse
    }
}

// MARK: - Fixtures

private func makeConnection(
    name: String = "my-conn",
    provider: String = "anthropic",
    authType: String = "api_key",
    credential: String? = "sk-test",
    label: String? = nil
) -> ProviderConnection {
    ProviderConnection(
        name: name,
        provider: provider,
        auth: ProviderConnectionAuth(type: authType, credential: credential),
        label: label,
        createdAt: 0,
        updatedAt: 0
    )
}

// MARK: - Tests

/// Verifies the generated `ProviderConnection` Codable conformance keeps the
/// macOS app working against daemons that predate the `isManaged` field.
/// Mixed-version setups must default missing `isManaged` to `false` rather
/// than throwing `keyNotFound` and stranding the Providers UI.
final class ProviderConnectionDecodingTests: XCTestCase {

    private func decode(_ jsonString: String) throws -> ProviderConnection {
        let data = jsonString.data(using: .utf8)!
        return try JSONDecoder().decode(ProviderConnection.self, from: data)
    }

    func testDecodesIsManagedWhenPresent() throws {
        let conn = try decode("""
        {
          "name": "anthropic-managed",
          "provider": "anthropic",
          "auth": { "type": "platform" },
          "isManaged": true,
          "createdAt": 1,
          "updatedAt": 2
        }
        """)
        XCTAssertTrue(conn.isManaged)
    }

    func testDefaultsIsManagedToFalseWhenKeyMissing() throws {
        let conn = try decode("""
        {
          "name": "my-conn",
          "provider": "anthropic",
          "auth": { "type": "api_key", "credential": "credential/anthropic/api_key" },
          "createdAt": 1,
          "updatedAt": 2
        }
        """)
        XCTAssertFalse(conn.isManaged)
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
        mock.createResponse = .created(conn)
        let auth = ProviderConnectionAuth(type: "api_key", credential: "sk-test")
        let result = await mock.createProviderConnection(name: "new-conn", provider: "anthropic", auth: auth, label: nil, baseUrl: nil, models: nil)
        guard case .created(let created) = result else {
            XCTFail("Expected .created result, got \(result)")
            return
        }
        XCTAssertEqual(created.name, "new-conn")
        XCTAssertEqual(mock.createNameArg, "new-conn")
        XCTAssertEqual(mock.createProviderArg, "anthropic")
        XCTAssertEqual(mock.createAuthArg?.type, "api_key")
        XCTAssertEqual(mock.createAuthArg?.credential, "sk-test")
    }

    func testCreateReturnsDuplicateOn409NameConflict() async {
        // 409 from the daemon (a connection with this name already exists)
        // surfaces as `.duplicate` so callers can show a precise message
        // instead of a generic "please try again."
        mock.createResponse = .duplicate
        let auth = ProviderConnectionAuth(type: "api_key", credential: "sk-test")
        let result = await mock.createProviderConnection(name: "existing", provider: "anthropic", auth: auth, label: nil, baseUrl: nil, models: nil)
        guard case .duplicate = result else {
            XCTFail("Expected .duplicate result, got \(result)")
            return
        }
    }

    func testCreateReturnsInvalidWithMessageOn400() async {
        // 400 carries the daemon's structured reason when available so the
        // sheet can echo it verbatim (e.g. `Invalid provider "x". Valid: ...`).
        mock.createResponse = .invalid(message: "Invalid auth configuration.")
        let auth = ProviderConnectionAuth(type: "api_key", credential: "")
        let result = await mock.createProviderConnection(name: "conn", provider: "anthropic", auth: auth, label: nil, baseUrl: nil, models: nil)
        guard case .invalid(let message) = result else {
            XCTFail("Expected .invalid result, got \(result)")
            return
        }
        XCTAssertEqual(message, "Invalid auth configuration.")
    }

    func testCreateReturnsErrorOnUnknownFailure() async {
        // Catch-all for network errors, 5xx, decode failures, etc.
        mock.createResponse = .error
        let auth = ProviderConnectionAuth(type: "api_key", credential: "sk-test")
        let result = await mock.createProviderConnection(name: "conn", provider: "anthropic", auth: auth, label: nil, baseUrl: nil, models: nil)
        guard case .error = result else {
            XCTFail("Expected .error result, got \(result)")
            return
        }
    }

    // MARK: - update

    func testUpdateReturnsConnectionOnSuccess() async {
        let conn = makeConnection(name: "conn")
        mock.updateResponse = conn
        let auth = ProviderConnectionAuth(type: "api_key", credential: "sk-new")
        let result = await mock.updateProviderConnection(name: "conn", auth: auth, label: nil, baseUrl: nil, models: nil)
        XCTAssertEqual(result?.name, "conn")
        XCTAssertEqual(mock.updateNameArg, "conn")
        XCTAssertEqual(mock.updateAuthArg?.credential, "sk-new")
    }

    func testUpdateReturnsNilOn404() async {
        mock.updateResponse = nil
        let auth = ProviderConnectionAuth(type: "api_key", credential: "sk-x")
        let result = await mock.updateProviderConnection(name: "missing", auth: auth, label: nil, baseUrl: nil, models: nil)
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
