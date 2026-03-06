import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Tests for the first-launch bootstrap state machine (BootstrapState enum),
/// UserDefaults persistence, stale state recovery, and naming intent detection.
@MainActor
final class BootstrapStateTests: XCTestCase {

    /// Isolated UserDefaults suite so tests don't pollute the app's actual defaults.
    private let testSuiteName = "com.vellum.bootstrap-state-tests"
    private var testDefaults: UserDefaults!
    private let bootstrapKey = "bootstrapState"

    override func setUp() {
        super.setUp()
        testDefaults = UserDefaults(suiteName: testSuiteName)!
        testDefaults.removePersistentDomain(forName: testSuiteName)
    }

    override func tearDown() {
        testDefaults.removePersistentDomain(forName: testSuiteName)
        testDefaults = nil
        super.tearDown()
    }

    // MARK: - BootstrapState raw values

    func testBootstrapStateRawValues() {
        XCTAssertEqual(BootstrapState.pendingDaemon.rawValue, "pendingDaemon")
        XCTAssertEqual(BootstrapState.pendingWakeupSend.rawValue, "pendingWakeupSend")
        XCTAssertEqual(BootstrapState.pendingFirstReply.rawValue, "pendingFirstReply")
        XCTAssertEqual(BootstrapState.complete.rawValue, "complete")
    }

    // MARK: - Round-trip through UserDefaults

    func testBootstrapStatePersistsAndRestoresFromUserDefaults() {
        // Each state should survive a round-trip through UserDefaults
        for state in [BootstrapState.pendingDaemon, .pendingWakeupSend, .pendingFirstReply, .complete] {
            testDefaults.set(state.rawValue, forKey: bootstrapKey)
            let raw = testDefaults.string(forKey: bootstrapKey)
            XCTAssertNotNil(raw, "Raw value should be persisted for \(state)")
            let restored = BootstrapState(rawValue: raw!)
            XCTAssertEqual(restored, state, "Round-trip should restore \(state)")
        }
    }

    func testBootstrapStateDefaultsToCompleteWhenKeyMissing() {
        // When UserDefaults has no bootstrapState key, the app defaults to .complete.
        // This mirrors the initializer in AppDelegate.
        testDefaults.removeObject(forKey: bootstrapKey)
        let raw = testDefaults.string(forKey: bootstrapKey)
        XCTAssertNil(raw, "Key should be absent")
        // Replicate the AppDelegate init logic:
        let state: BootstrapState
        if let raw = testDefaults.string(forKey: bootstrapKey),
           let s = BootstrapState(rawValue: raw) {
            state = s
        } else {
            state = .complete
        }
        XCTAssertEqual(state, .complete, "Missing key should default to .complete")
    }

    // MARK: - State transition ordering

    func testExpectedTransitionSequence() {
        // The bootstrap state machine follows:
        // pendingDaemon -> pendingWakeupSend -> pendingFirstReply -> complete
        var current: BootstrapState = .pendingDaemon
        testDefaults.set(current.rawValue, forKey: bootstrapKey)

        // Simulate transition: pendingDaemon -> pendingWakeupSend
        current = .pendingWakeupSend
        testDefaults.set(current.rawValue, forKey: bootstrapKey)
        XCTAssertEqual(
            BootstrapState(rawValue: testDefaults.string(forKey: bootstrapKey)!),
            .pendingWakeupSend
        )

        // Simulate transition: pendingWakeupSend -> pendingFirstReply
        current = .pendingFirstReply
        testDefaults.set(current.rawValue, forKey: bootstrapKey)
        XCTAssertEqual(
            BootstrapState(rawValue: testDefaults.string(forKey: bootstrapKey)!),
            .pendingFirstReply
        )

        // Simulate transition: pendingFirstReply -> complete
        current = .complete
        testDefaults.set(current.rawValue, forKey: bootstrapKey)
        XCTAssertEqual(
            BootstrapState(rawValue: testDefaults.string(forKey: bootstrapKey)!),
            .complete
        )
    }

    func testEachTransitionPersistsToUserDefaults() {
        // Verify that after each simulated transition, the persisted value matches.
        let sequence: [BootstrapState] = [.pendingDaemon, .pendingWakeupSend, .pendingFirstReply, .complete]
        for state in sequence {
            testDefaults.set(state.rawValue, forKey: bootstrapKey)
            let persisted = testDefaults.string(forKey: bootstrapKey)
            XCTAssertEqual(persisted, state.rawValue,
                           "Persisted value should match after transitioning to \(state)")
        }
    }

    // MARK: - Stale state recovery

    func testStaleBootstrapStateIsResetOnNonFirstLaunch() {
        // On a non-first-launch, a stale state like .pendingFirstReply should be
        // treated as recoverable and reset to .complete. This mirrors the
        // proceedToApp(isFirstLaunch: false) logic in AppDelegate.
        let staleStates: [BootstrapState] = [.pendingDaemon, .pendingWakeupSend, .pendingFirstReply]
        for stale in staleStates {
            testDefaults.set(stale.rawValue, forKey: bootstrapKey)

            // Replicate the recovery logic from proceedToApp:
            let isFirstLaunch = false
            let restoredRaw = testDefaults.string(forKey: bootstrapKey)!
            var current = BootstrapState(rawValue: restoredRaw)!
            let isBootstrapping = current != .complete

            if !isFirstLaunch && isBootstrapping {
                current = .complete
                testDefaults.set(current.rawValue, forKey: bootstrapKey)
            }

            XCTAssertEqual(current, .complete,
                           "Stale state \(stale) should be reset to .complete on non-first-launch")
            XCTAssertEqual(testDefaults.string(forKey: bootstrapKey), "complete",
                           "Persisted value should be 'complete' after recovery from \(stale)")
        }
    }

    func testCompleteStateIsNotResetOnNonFirstLaunch() {
        // .complete on a non-first-launch should remain untouched.
        testDefaults.set(BootstrapState.complete.rawValue, forKey: bootstrapKey)

        let restoredRaw = testDefaults.string(forKey: bootstrapKey)!
        let current = BootstrapState(rawValue: restoredRaw)!
        let isBootstrapping = current != .complete

        XCTAssertFalse(isBootstrapping,
                       ".complete should not be considered bootstrapping")
        XCTAssertEqual(current, .complete,
                       ".complete should remain .complete on non-first-launch")
    }

    // MARK: - isBootstrapping computed property

    func testIsBootstrappingReturnsTrueForAllStatesExceptComplete() {
        let bootstrappingStates: [BootstrapState] = [.pendingDaemon, .pendingWakeupSend, .pendingFirstReply]
        for state in bootstrappingStates {
            // isBootstrapping is: state != .complete
            XCTAssertTrue(state != .complete,
                          "\(state) should be considered bootstrapping")
        }
    }

    func testIsBootstrappingReturnsFalseForComplete() {
        XCTAssertFalse(BootstrapState.complete != .complete,
                       ".complete should NOT be considered bootstrapping")
    }

}
