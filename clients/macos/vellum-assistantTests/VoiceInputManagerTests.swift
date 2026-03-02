import XCTest
@testable import VellumAssistantLib

@MainActor
final class VoiceInputManagerTests: XCTestCase {

    private var manager: VoiceInputManager!

    override func setUp() {
        super.setUp()
        manager = VoiceInputManager()
    }

    override func tearDown() {
        manager = nil
        super.tearDown()
    }

    // MARK: - shouldStartRecording

    func testActivationKeyAloneAfterAppSwitch() {
        let result = manager.shouldStartRecording(
            activationKeyPressed: true,
            otherKeyPressed: false,
            timeSinceAppSwitch: 1.0,
            isAlreadyRecording: false
        )
        XCTAssertTrue(result)
    }

    func testOtherKeyPressedDuringHold() {
        let result = manager.shouldStartRecording(
            activationKeyPressed: true,
            otherKeyPressed: true,
            timeSinceAppSwitch: 1.0,
            isAlreadyRecording: false
        )
        XCTAssertFalse(result, "Should not start recording when another key is pressed during hold")
    }

    func testRecentAppSwitch() {
        let result = manager.shouldStartRecording(
            activationKeyPressed: true,
            otherKeyPressed: false,
            timeSinceAppSwitch: 0.3,
            isAlreadyRecording: false
        )
        XCTAssertFalse(result, "Should not start recording within 0.5s of app switch")
    }

    func testAppSwitchExactlyAtThreshold() {
        let result = manager.shouldStartRecording(
            activationKeyPressed: true,
            otherKeyPressed: false,
            timeSinceAppSwitch: 0.5,
            isAlreadyRecording: false
        )
        XCTAssertFalse(result, "Should not start recording at exactly 0.5s (not >)")
    }

    func testAlreadyRecording() {
        let result = manager.shouldStartRecording(
            activationKeyPressed: true,
            otherKeyPressed: false,
            timeSinceAppSwitch: 1.0,
            isAlreadyRecording: true
        )
        XCTAssertFalse(result, "Should not start recording when already recording")
    }

    func testActivationKeyNotPressed() {
        let result = manager.shouldStartRecording(
            activationKeyPressed: false,
            otherKeyPressed: false,
            timeSinceAppSwitch: 1.0,
            isAlreadyRecording: false
        )
        XCTAssertFalse(result, "Should not start recording when activation key is not pressed")
    }
}
