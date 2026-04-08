import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class PermissionModeStatusModelTests: XCTestCase {
    private var connectionManager: GatewayConnectionManager!
    private var mockClient: MockPermissionModeClient!
    private var model: PermissionModeStatusModel!

    override func setUp() {
        super.setUp()
        connectionManager = GatewayConnectionManager()
        mockClient = MockPermissionModeClient()
        model = PermissionModeStatusModel(
            connectionManager: connectionManager,
            permissionModeClient: mockClient
        )
    }

    override func tearDown() {
        model = nil
        mockClient = nil
        connectionManager = nil
        super.tearDown()
    }

    func testToggleAskBeforeActingAppliesSuccessfulResponseToConnectionManager() {
        mockClient.updateResponse = PermissionModeUpdateMessage(
            askBeforeActing: false,
            hostAccess: false
        )

        model.toggleAskBeforeActing()

        let predicate = NSPredicate { _, _ in
            self.connectionManager.permissionMode?.askBeforeActing == false &&
            self.model.isUpdating == false
        }
        wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: 2.0)

        XCTAssertEqual(mockClient.updateCalls.count, 1)
        XCTAssertEqual(mockClient.updateCalls[0].askBeforeActing, false)
        XCTAssertEqual(connectionManager.permissionMode?.askBeforeActing, false)
        XCTAssertFalse(model.askBeforeActing)
        XCTAssertNil(model.lastError)
    }

    func testToggleHostAccessAppliesSuccessfulResponseToConnectionManager() {
        mockClient.updateResponse = PermissionModeUpdateMessage(
            askBeforeActing: true,
            hostAccess: true
        )

        model.toggleHostAccess()

        let predicate = NSPredicate { _, _ in
            self.connectionManager.permissionMode?.hostAccess == true &&
            self.model.isUpdating == false
        }
        wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: 2.0)

        XCTAssertEqual(mockClient.updateCalls.count, 1)
        XCTAssertEqual(mockClient.updateCalls[0].hostAccess, true)
        XCTAssertEqual(connectionManager.permissionMode?.hostAccess, true)
        XCTAssertTrue(model.hostAccess)
        XCTAssertNil(model.lastError)
    }

    func testFailedUpdateSurfacesErrorWithoutChangingMode() {
        mockClient.updateResponse = nil

        model.toggleHostAccess()

        let predicate = NSPredicate { _, _ in
            self.model.isUpdating == false && self.model.lastError != nil
        }
        wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: 2.0)

        XCTAssertEqual(mockClient.updateCalls.count, 1)
        XCTAssertEqual(mockClient.updateCalls[0].hostAccess, true)
        XCTAssertNil(connectionManager.permissionMode)
        XCTAssertFalse(model.hostAccess)
        XCTAssertEqual(model.lastError, "Couldn't update permission controls.")
    }
}

private final class MockPermissionModeClient: PermissionModeClientProtocol {
    struct UpdateCall {
        let askBeforeActing: Bool?
        let hostAccess: Bool?
    }

    var updateResponse: PermissionModeUpdateMessage?
    private(set) var updateCalls: [UpdateCall] = []

    func fetchPermissionMode() async -> PermissionModeUpdateMessage? {
        nil
    }

    func updatePermissionMode(
        askBeforeActing: Bool?,
        hostAccess: Bool?
    ) async -> PermissionModeUpdateMessage? {
        updateCalls.append(UpdateCall(askBeforeActing: askBeforeActing, hostAccess: hostAccess))
        return updateResponse
    }
}
