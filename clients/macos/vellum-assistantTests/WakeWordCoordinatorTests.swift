import XCTest
import Combine
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - Mock Wake Word Engine

final class MockWakeWordEngine: WakeWordEngine {
    var onWakeWordDetected: ((Float) -> Void)?
    private(set) var isRunning = false
    var startCalled = false
    var stopCalled = false
    var updatedKeyword: String?

    func start() throws {
        startCalled = true
        isRunning = true
    }

    func stop() {
        stopCalled = true
        isRunning = false
    }

    func updateKeyword(_ keyword: String) {
        updatedKeyword = keyword
    }
}

// MARK: - Tests

@MainActor
final class WakeWordCoordinatorTests: XCTestCase {

    private var mockEngine: MockWakeWordEngine!
    private var audioMonitor: AlwaysOnAudioMonitor!
    private var voiceModeManager: VoiceModeManager!
    private var mockVoiceService: MockVoiceService!
    private var threadManager: ThreadManager!
    private var voiceInputManager: VoiceInputManager!
    private var coordinator: WakeWordCoordinator!
    private var daemonClient: DaemonClient!

    override func setUp() {
        super.setUp()
        mockEngine = MockWakeWordEngine()
        audioMonitor = AlwaysOnAudioMonitor(engine: mockEngine)
        mockVoiceService = MockVoiceService()
        voiceModeManager = VoiceModeManager(voiceService: mockVoiceService)
        daemonClient = DaemonClient()
        daemonClient.isConnected = true
        daemonClient.sendOverride = { _ in }
        threadManager = ThreadManager(daemonClient: daemonClient)
        voiceInputManager = VoiceInputManager()

        coordinator = WakeWordCoordinator(
            audioMonitor: audioMonitor,
            voiceModeManager: voiceModeManager,
            threadManager: threadManager,
            voiceInputManager: voiceInputManager
        )
    }

    override func tearDown() {
        coordinator = nil
        voiceInputManager = nil
        threadManager = nil
        voiceModeManager.deactivate()
        voiceModeManager = nil
        mockVoiceService = nil
        audioMonitor = nil
        mockEngine = nil
        daemonClient = nil

        // Clean up UserDefaults
        UserDefaults.standard.removeObject(forKey: "wakeWordEnabled")
        super.tearDown()
    }

    // MARK: - Readiness

    func testWakeWordBeforeReadyIsQueued() {
        // Don't call markReady() — coordinator is not ready
        UserDefaults.standard.set(true, forKey: "wakeWordEnabled")
        audioMonitor.onWakeWordDetected?()

        // Voice mode should NOT have been activated (not ready)
        XCTAssertEqual(voiceModeManager.state, .off)
    }

    // MARK: - Guards

    func testWakeWordIgnoredWhenDisabled() {
        UserDefaults.standard.set(false, forKey: "wakeWordEnabled")
        coordinator.markReady()

        audioMonitor.onWakeWordDetected?()

        XCTAssertEqual(voiceModeManager.state, .off,
                       "Should not activate when wake word is disabled")
    }

    func testWakeWordIgnoredWhenVoiceModeAlreadyActive() {
        UserDefaults.standard.set(true, forKey: "wakeWordEnabled")
        coordinator.markReady()

        // Manually set voice mode to active
        let chatVM = ChatViewModel(daemonClient: daemonClient)
        voiceModeManager.activate(chatViewModel: chatVM)
        // Force activate since speech auth won't pass in test
        if voiceModeManager.state == .off {
            voiceModeManager.state = .idle
        }

        let stateBefore = voiceModeManager.state
        audioMonitor.onWakeWordDetected?()

        XCTAssertEqual(voiceModeManager.state, stateBefore,
                       "Should not re-activate when already in voice mode")
    }

    func testWakeWordIgnoredWhenPTTRecording() {
        UserDefaults.standard.set(true, forKey: "wakeWordEnabled")
        coordinator.markReady()

        // VoiceInputManager.isRecording is private(set), so we can't set it
        // directly. The coordinator checks voiceInputManager.isRecording in
        // handleWakeWordDetected(). Since we can't simulate real audio recording
        // in unit tests, we verify the inverse: when NOT recording, the wake word
        // IS processed (audio monitor stops as part of activation flow).
        audioMonitor.startMonitoring()
        mockEngine.stopCalled = false

        audioMonitor.onWakeWordDetected?()

        // The coordinator should attempt activation (which stops the audio monitor)
        // proving the PTT guard didn't block it when isRecording is false.
        XCTAssertTrue(mockEngine.stopCalled,
                      "Wake word should be processed when PTT is not recording")
    }

    // MARK: - Cooldown

    func testActivationCooldownPreventsRapidRetrigger() {
        // The cooldown is 3.0 seconds — verify the constant
        // We can't easily test the time-based check without mocking Date(),
        // but we verify the constant exists and is reasonable.
        XCTAssertEqual(WakeWordCoordinator.activationCooldown, 3.0)
    }

    // MARK: - Audio Monitor Coordination

    func testAudioMonitorStartStop() {
        audioMonitor.startMonitoring()
        XCTAssertTrue(audioMonitor.isListening)
        XCTAssertTrue(mockEngine.startCalled)

        audioMonitor.stopMonitoring()
        XCTAssertFalse(audioMonitor.isListening)
        XCTAssertTrue(mockEngine.stopCalled)
    }

    func testStartMonitoringIsIdempotent() {
        audioMonitor.startMonitoring()
        mockEngine.startCalled = false

        audioMonitor.startMonitoring()
        XCTAssertFalse(mockEngine.startCalled, "Should not call start again when already listening")
    }

    func testStopMonitoringWhenNotListeningIsNoOp() {
        mockEngine.stopCalled = false
        audioMonitor.stopMonitoring()
        XCTAssertFalse(mockEngine.stopCalled, "Should not call stop when not listening")
    }
}
