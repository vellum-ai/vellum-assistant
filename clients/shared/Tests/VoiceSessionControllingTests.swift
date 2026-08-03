import Foundation
import XCTest

@testable import VellumAssistantShared

/// A minimal fake conforming only to `VoiceSessionControlling`, with no
/// dependency on any platform-specific session manager. Standing in for a
/// future control surface (e.g. an iOS Live Activity/Dynamic Island control,
/// or a spoken-command dispatcher) that should be writable against this
/// protocol alone.
@MainActor
private final class FakeVoiceSessionControls: VoiceSessionControlling {
    private(set) var isMicrophoneMuted = false
    private(set) var isAssistantOutputMuted = false
    private(set) var endCallCount = 0

    func setMicrophoneMuted(_ muted: Bool) {
        isMicrophoneMuted = muted
    }

    func setAssistantOutputMuted(_ muted: Bool) {
        isAssistantOutputMuted = muted
    }

    func end() async {
        endCallCount += 1
    }
}

/// Simulates a control surface written once against `VoiceSessionControlling`
/// and reusable across any conforming session manager, on any platform.
@MainActor
private func muteEverythingThenEndSession(_ controls: any VoiceSessionControlling) async {
    controls.setMicrophoneMuted(true)
    controls.setAssistantOutputMuted(true)
    await controls.end()
}

@MainActor
final class VoiceSessionControllingTests: XCTestCase {
    func testControlSurfaceCanDriveMuteAndEndThroughTheProtocolAlone() async {
        let controls = FakeVoiceSessionControls()

        await muteEverythingThenEndSession(controls)

        XCTAssertTrue(controls.isMicrophoneMuted)
        XCTAssertTrue(controls.isAssistantOutputMuted)
        XCTAssertEqual(controls.endCallCount, 1)
    }

    func testMicrophoneAndAssistantOutputMuteAreIndependentToggles() {
        let controls = FakeVoiceSessionControls()

        controls.setMicrophoneMuted(true)

        XCTAssertTrue(controls.isMicrophoneMuted)
        XCTAssertFalse(controls.isAssistantOutputMuted)

        controls.setAssistantOutputMuted(true)
        controls.setMicrophoneMuted(false)

        XCTAssertFalse(controls.isMicrophoneMuted)
        XCTAssertTrue(controls.isAssistantOutputMuted)
    }
}
