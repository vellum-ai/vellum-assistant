import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Verifies that `SettingsStore` emits the expected config patch payloads
/// for the `services.stt` namespace and correctly loads STT provider config
/// from daemon config responses.
@MainActor
final class SettingsStoreVoiceServiceTests: XCTestCase {

    private var mockSettingsClient: MockSettingsClient!
    private var store: SettingsStore!

    override func setUp() {
        super.setUp()
        mockSettingsClient = MockSettingsClient()
        mockSettingsClient.patchConfigResponse = true
        store = SettingsStore(settingsClient: mockSettingsClient)
    }

    override func tearDown() {
        store = nil
        mockSettingsClient = nil
        super.tearDown()
    }

    // MARK: - Helpers

    /// Returns the most recent `services.stt` patch payload captured
    /// by the mock client, or `nil` if no such patch has been emitted.
    private func lastSTTPatch() -> [String: Any]? {
        for payload in mockSettingsClient.patchConfigCalls.reversed() {
            if let services = payload["services"] as? [String: Any],
               let stt = services["stt"] as? [String: Any] {
                return stt
            }
        }
        return nil
    }

    /// Returns the most recent `services.tts` patch payload captured
    /// by the mock client, or `nil` if no such patch has been emitted.
    private func lastTTSPatch() -> [String: Any]? {
        for payload in mockSettingsClient.patchConfigCalls.reversed() {
            if let services = payload["services"] as? [String: Any],
               let tts = services["tts"] as? [String: Any] {
                return tts
            }
        }
        return nil
    }

    /// Waits for the background `Task` started by a store helper to flush
    /// its patch into the mock client.
    private func waitForPatchCount(_ expected: Int, timeout: TimeInterval = 2.0) {
        let predicate = NSPredicate { _, _ in
            self.mockSettingsClient.patchConfigCalls.count >= expected
        }
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
        wait(for: [expectation], timeout: timeout)
    }

    // MARK: - setSTTProvider

    func testSetSTTProviderEmitsExpectedPatch() {
        store.setSTTProvider("openai-whisper")

        waitForPatchCount(1)

        let patch = lastSTTPatch()
        XCTAssertNotNil(patch, "expected a services.stt patch payload")
        XCTAssertEqual(patch?["provider"] as? String, "openai-whisper")
    }

    func testSetSTTProviderDoesNotEmitTTSPatch() {
        store.setSTTProvider("openai-whisper")

        waitForPatchCount(1)

        let ttsPatch = lastTTSPatch()
        XCTAssertNil(ttsPatch, "setSTTProvider must not emit a TTS patch")
    }

    func testSetTTSProviderDoesNotEmitSTTPatch() {
        store.setTTSProvider("elevenlabs")

        waitForPatchCount(1)

        let sttPatch = lastSTTPatch()
        XCTAssertNil(sttPatch, "setTTSProvider must not emit an STT patch")
    }

    // MARK: - applyDaemonConfig STT loading

    func testApplyDaemonConfigSyncsSTTProvider() {
        // Clear any existing value to confirm the config load writes it.
        UserDefaults.standard.removeObject(forKey: "sttProvider")

        let config: [String: Any] = [
            "services": [
                "stt": [
                    "provider": "openai-whisper"
                ]
            ]
        ]

        // loadConfigFromDaemon calls applyDaemonConfig internally, but
        // we can test the effect by setting up the mock response and calling load.
        mockSettingsClient.fetchConfigResponse = config
        let expectation = XCTestExpectation(description: "config loaded")
        Task {
            await store.loadConfigFromDaemon()
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "sttProvider"),
            "openai-whisper"
        )
    }

    func testApplyDaemonConfigSyncsTTSProvider() {
        // Verify TTS loading still works alongside STT.
        UserDefaults.standard.removeObject(forKey: "ttsProvider")

        let config: [String: Any] = [
            "services": [
                "tts": [
                    "provider": "fish-audio"
                ]
            ]
        ]

        mockSettingsClient.fetchConfigResponse = config
        let expectation = XCTestExpectation(description: "config loaded")
        Task {
            await store.loadConfigFromDaemon()
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "ttsProvider"),
            "fish-audio"
        )
    }

    func testApplyDaemonConfigSyncsBothTTSAndSTT() {
        UserDefaults.standard.removeObject(forKey: "ttsProvider")
        UserDefaults.standard.removeObject(forKey: "sttProvider")

        let config: [String: Any] = [
            "services": [
                "tts": [
                    "provider": "elevenlabs"
                ],
                "stt": [
                    "provider": "openai-whisper"
                ]
            ]
        ]

        mockSettingsClient.fetchConfigResponse = config
        let expectation = XCTestExpectation(description: "config loaded")
        Task {
            await store.loadConfigFromDaemon()
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(UserDefaults.standard.string(forKey: "ttsProvider"), "elevenlabs")
        XCTAssertEqual(UserDefaults.standard.string(forKey: "sttProvider"), "openai-whisper")
    }

    func testApplyDaemonConfigDoesNotOverwriteSTTWhenMissing() {
        // Pre-seed a value and verify it is not cleared when the
        // daemon config does not include an stt section.
        UserDefaults.standard.set("openai-whisper", forKey: "sttProvider")

        let config: [String: Any] = [
            "services": [
                "tts": [
                    "provider": "elevenlabs"
                ]
            ]
        ]

        mockSettingsClient.fetchConfigResponse = config
        let expectation = XCTestExpectation(description: "config loaded")
        Task {
            await store.loadConfigFromDaemon()
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "sttProvider"),
            "openai-whisper",
            "STT provider must not be cleared when the daemon config omits stt"
        )
    }

    // MARK: - setSTTProvider with Deepgram

    func testSetSTTProviderDeepgramEmitsExpectedPatch() {
        store.setSTTProvider("deepgram")

        waitForPatchCount(1)

        let patch = lastSTTPatch()
        XCTAssertNotNil(patch, "expected a services.stt patch payload for deepgram")
        XCTAssertEqual(patch?["provider"] as? String, "deepgram")
    }

    func testApplyDaemonConfigSyncsDeepgramSTTProvider() {
        UserDefaults.standard.removeObject(forKey: "sttProvider")

        let config: [String: Any] = [
            "services": [
                "stt": [
                    "provider": "deepgram"
                ]
            ]
        ]

        mockSettingsClient.fetchConfigResponse = config
        let expectation = XCTestExpectation(description: "config loaded")
        Task {
            await store.loadConfigFromDaemon()
            expectation.fulfill()
        }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "sttProvider"),
            "deepgram"
        )
    }

    // MARK: - sttApiKeyProviderName mapping

    func testSTTApiKeyProviderNameResolvesOpenAIWhisperToOpenAI() {
        // openai-whisper shares the "openai" API key
        let keyName = SettingsStore.sttApiKeyProviderName(for: "openai-whisper")
        XCTAssertEqual(keyName, "openai")
    }

    func testSTTApiKeyProviderNameResolvesDeepgramToDeepgram() {
        let keyName = SettingsStore.sttApiKeyProviderName(for: "deepgram")
        XCTAssertEqual(keyName, "deepgram")
    }

    func testSTTApiKeyProviderNameFallsBackToProviderIdForUnknown() {
        // Unknown providers fall back to the provider id itself
        let keyName = SettingsStore.sttApiKeyProviderName(for: "unknown-provider")
        XCTAssertEqual(keyName, "unknown-provider")
    }
}
