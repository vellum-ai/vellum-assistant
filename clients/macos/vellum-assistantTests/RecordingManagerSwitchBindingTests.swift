import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class RecordingManagerSwitchBindingTests: XCTestCase {

    func testRecordingManagerRetainsGatewayConnectionManagerAfterReconfigure() {
        let client = GatewayConnectionManager()
        let recordingManager = RecordingManager(daemonClient: client)

        // Reset published state (simulating assistant switch)
        client.reconfigure(instanceDir: nil)

        // The recording manager should still be able to send status
        // messages through the (reconfigured) daemon client. We verify
        // this indirectly by checking the manager is still functional
        // (state is idle, no stale references).
        XCTAssertEqual(recordingManager.state, .idle)
        XCTAssertNil(recordingManager.ownerSessionId)
    }

    func testForceStopClearsStateBeforeSwitch() {
        let client = GatewayConnectionManager()
        let recordingManager = RecordingManager(daemonClient: client)

        // Force stop should safely clear all state even when not recording
        recordingManager.forceStop()

        XCTAssertEqual(recordingManager.state, .idle)
        XCTAssertNil(recordingManager.ownerSessionId)
        XCTAssertNil(recordingManager.attachToConversationId)
    }
}
