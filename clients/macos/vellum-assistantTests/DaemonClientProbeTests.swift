import XCTest
@testable import VellumAssistantShared

@MainActor
final class DaemonClientProbeTests: XCTestCase {

    private var client: DaemonClient!

    override func setUp() {
        super.setUp()
        client = DaemonClient()
    }

    override func tearDown() {
        client.disconnect()
        client = nil
        super.tearDown()
    }

    // MARK: - Probe result state transitions

    func testProbeResultOkSetsAvailableTrue() {
        client.pendingProbeId = "probe-1"

        client.handleBlobProbeResult(IpcBlobProbeResultMessage(
            type: "ipc_blob_probe_result",
            probeId: "probe-1",
            ok: true,
            observedNonceSha256: "abc123",
            reason: nil
        ))

        XCTAssertTrue(client.isBlobTransportAvailable)
    }

    func testProbeResultNotOkSetsAvailableFalse() {
        // First set it to true via a successful probe
        client.pendingProbeId = "probe-1"
        client.handleBlobProbeResult(IpcBlobProbeResultMessage(
            type: "ipc_blob_probe_result",
            probeId: "probe-1",
            ok: true,
            observedNonceSha256: "abc123",
            reason: nil
        ))
        XCTAssertTrue(client.isBlobTransportAvailable)

        // Now a failed probe
        client.pendingProbeId = "probe-2"
        client.handleBlobProbeResult(IpcBlobProbeResultMessage(
            type: "ipc_blob_probe_result",
            probeId: "probe-2",
            ok: false,
            observedNonceSha256: nil,
            reason: "hash mismatch"
        ))

        XCTAssertFalse(client.isBlobTransportAvailable)
    }

    func testStaleProbeResultIsIgnored() {
        client.pendingProbeId = "probe-2"

        // Send a result for a different probe ID
        client.handleBlobProbeResult(IpcBlobProbeResultMessage(
            type: "ipc_blob_probe_result",
            probeId: "probe-1",
            ok: true,
            observedNonceSha256: "abc123",
            reason: nil
        ))

        // Should remain false — stale result was ignored
        XCTAssertFalse(client.isBlobTransportAvailable)
        // pendingProbeId should NOT be cleared for stale results
        XCTAssertEqual(client.pendingProbeId, "probe-2")
    }

    func testProbeResultClearsPendingProbeId() {
        client.pendingProbeId = "probe-1"

        client.handleBlobProbeResult(IpcBlobProbeResultMessage(
            type: "ipc_blob_probe_result",
            probeId: "probe-1",
            ok: true,
            observedNonceSha256: "abc123",
            reason: nil
        ))

        XCTAssertNil(client.pendingProbeId)
    }

    func testProbeResultWithNoPendingIdIsIgnored() {
        // No pendingProbeId set (nil)
        client.handleBlobProbeResult(IpcBlobProbeResultMessage(
            type: "ipc_blob_probe_result",
            probeId: "probe-1",
            ok: true,
            observedNonceSha256: "abc123",
            reason: nil
        ))

        XCTAssertFalse(client.isBlobTransportAvailable)
    }

    // MARK: - Disconnect resets probe state

    func testDisconnectResetsAvailableToFalse() {
        // Set up a successful probe
        client.pendingProbeId = "probe-1"
        client.handleBlobProbeResult(IpcBlobProbeResultMessage(
            type: "ipc_blob_probe_result",
            probeId: "probe-1",
            ok: true,
            observedNonceSha256: "abc123",
            reason: nil
        ))
        XCTAssertTrue(client.isBlobTransportAvailable)

        // Disconnect
        client.disconnect()

        XCTAssertFalse(client.isBlobTransportAvailable)
    }

    func testDisconnectClearsPendingProbeId() {
        client.pendingProbeId = "probe-1"

        client.disconnect()

        XCTAssertNil(client.pendingProbeId)
    }

    // MARK: - Initial state

    func testInitialStateIsFalse() {
        let fresh = DaemonClient()
        XCTAssertFalse(fresh.isBlobTransportAvailable)
        XCTAssertNil(fresh.pendingProbeId)
        fresh.disconnect()
    }
}
