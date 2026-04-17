import XCTest
@testable import VellumAssistantShared

final class MemoryPressureMonitorTests: XCTestCase {

    // The monitor is a process-wide singleton, so reset it back to `.normal`
    // between cases to keep tests independent.
    override func tearDown() async throws {
        MemoryPressureMonitor.shared._testingSetLevel(.normal)
        try await Task.sleep(nanoseconds: 50_000_000)
        try await super.tearDown()
    }

    func testIsElevatedFlag() {
        XCTAssertFalse(MemoryPressureLevel.normal.isElevated)
        XCTAssertTrue(MemoryPressureLevel.warning.isElevated)
        XCTAssertTrue(MemoryPressureLevel.critical.isElevated)
    }

    func testListenerReceivesLevelChange() async {
        let expectation = expectation(description: "listener fires on level change")
        expectation.expectedFulfillmentCount = 1

        let received = Locked<[MemoryPressureLevel]>([])
        let token = MemoryPressureMonitor.shared.addListener { level in
            received.mutate { $0.append(level) }
            expectation.fulfill()
        }
        defer { MemoryPressureMonitor.shared.removeListener(token) }

        MemoryPressureMonitor.shared._testingSetLevel(.warning)
        await fulfillment(of: [expectation], timeout: 2.0)

        XCTAssertEqual(received.value, [.warning])
        XCTAssertEqual(MemoryPressureMonitor.shared.current, .warning)
    }

    func testListenerDoesNotFireWhenLevelUnchanged() async throws {
        let expectation = expectation(description: "listener fires exactly once")
        expectation.expectedFulfillmentCount = 1

        let received = Locked<[MemoryPressureLevel]>([])
        let token = MemoryPressureMonitor.shared.addListener { level in
            received.mutate { $0.append(level) }
            expectation.fulfill()
        }
        defer { MemoryPressureMonitor.shared.removeListener(token) }

        MemoryPressureMonitor.shared._testingSetLevel(.critical)
        // Second emission at same level should be coalesced (no fire).
        MemoryPressureMonitor.shared._testingSetLevel(.critical)

        await fulfillment(of: [expectation], timeout: 2.0)
        XCTAssertEqual(received.value, [.critical])
    }

    func testRemovedListenerDoesNotFire() async throws {
        let received = Locked<[MemoryPressureLevel]>([])
        let token = MemoryPressureMonitor.shared.addListener { level in
            received.mutate { $0.append(level) }
        }
        MemoryPressureMonitor.shared.removeListener(token)

        MemoryPressureMonitor.shared._testingSetLevel(.warning)
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertTrue(received.value.isEmpty)
    }

    func testMultipleListenersAllReceiveEvent() async {
        let expectationA = expectation(description: "listener A fires")
        let expectationB = expectation(description: "listener B fires")

        let tokenA = MemoryPressureMonitor.shared.addListener { _ in
            expectationA.fulfill()
        }
        let tokenB = MemoryPressureMonitor.shared.addListener { _ in
            expectationB.fulfill()
        }
        defer {
            MemoryPressureMonitor.shared.removeListener(tokenA)
            MemoryPressureMonitor.shared.removeListener(tokenB)
        }

        MemoryPressureMonitor.shared._testingSetLevel(.warning)
        await fulfillment(of: [expectationA, expectationB], timeout: 2.0)
    }
}

/// Minimal thread-safe box used to accumulate listener invocations from
/// the monitor's main-queue callback dispatch without tripping Swift's
/// strict concurrency checker.
private final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: Value

    init(_ value: Value) {
        self._value = value
    }

    var value: Value {
        lock.lock()
        defer { lock.unlock() }
        return _value
    }

    func mutate(_ body: (inout Value) -> Void) {
        lock.lock()
        body(&_value)
        lock.unlock()
    }
}
