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

    // MARK: - Deepgram provider patching roundtrip

    func testSetSTTProviderDeepgramDoesNotEmitTTSPatch() {
        store.setSTTProvider("deepgram")

        waitForPatchCount(1)

        let ttsPatch = lastTTSPatch()
        XCTAssertNil(ttsPatch, "setSTTProvider(deepgram) must not emit a TTS patch")
    }

    func testApplyDaemonConfigSyncsDeepgramWithExistingOpenAISTT() {
        // Start with openai-whisper persisted, then receive deepgram from the daemon
        UserDefaults.standard.set("openai-whisper", forKey: "sttProvider")

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
            "deepgram",
            "Daemon config should overwrite the persisted STT provider"
        )
    }

    func testSequentialSTTProviderPatchesEmitCorrectProviders() {
        // Patch openai-whisper then deepgram — both should produce distinct payloads
        store.setSTTProvider("openai-whisper")
        waitForPatchCount(1)

        store.setSTTProvider("deepgram")
        waitForPatchCount(2)

        let patch = lastSTTPatch()
        XCTAssertEqual(
            patch?["provider"] as? String,
            "deepgram",
            "Most recent STT patch should reflect the deepgram provider"
        )
    }

    // MARK: - setSTTProvider with Google Gemini

    func testSetSTTProviderGoogleGeminiEmitsExpectedPatch() {
        store.setSTTProvider("google-gemini")

        waitForPatchCount(1)

        let patch = lastSTTPatch()
        XCTAssertNotNil(patch, "expected a services.stt patch payload for google-gemini")
        XCTAssertEqual(patch?["provider"] as? String, "google-gemini")
    }

    func testSetSTTProviderGoogleGeminiDoesNotEmitTTSPatch() {
        store.setSTTProvider("google-gemini")

        waitForPatchCount(1)

        let ttsPatch = lastTTSPatch()
        XCTAssertNil(ttsPatch, "setSTTProvider(google-gemini) must not emit a TTS patch")
    }

    func testApplyDaemonConfigSyncsGoogleGeminiSTTProvider() {
        UserDefaults.standard.removeObject(forKey: "sttProvider")

        let config: [String: Any] = [
            "services": [
                "stt": [
                    "provider": "google-gemini"
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
            "google-gemini"
        )
    }

    func testApplyDaemonConfigSyncsGoogleGeminiWithExistingDeepgramSTT() {
        // Start with deepgram persisted, then receive google-gemini from the daemon
        UserDefaults.standard.set("deepgram", forKey: "sttProvider")

        let config: [String: Any] = [
            "services": [
                "stt": [
                    "provider": "google-gemini"
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
            "google-gemini",
            "Daemon config should overwrite the persisted STT provider"
        )
    }

    func testSequentialSTTProviderPatchesIncludingGoogleGemini() {
        // Patch deepgram then google-gemini — both should produce distinct payloads
        store.setSTTProvider("deepgram")
        waitForPatchCount(1)

        store.setSTTProvider("google-gemini")
        waitForPatchCount(2)

        let patch = lastSTTPatch()
        XCTAssertEqual(
            patch?["provider"] as? String,
            "google-gemini",
            "Most recent STT patch should reflect the google-gemini provider"
        )
    }

    // MARK: - sttApiKeyProviderName mapping (Google Gemini)

    func testSTTApiKeyProviderNameResolvesGoogleGeminiToGemini() {
        // google-gemini shares the "gemini" API key
        let keyName = SettingsStore.sttApiKeyProviderName(for: "google-gemini")
        XCTAssertEqual(keyName, "gemini")
    }

    // MARK: - STT Key Ownership Semantics

    func testSharedKeyProviderIsNotExclusive() {
        // openai-whisper maps to the "openai" credential — shared with
        // Inference, so it must NOT be classified as exclusive.
        XCTAssertFalse(
            SettingsStore.sttKeyIsExclusive(for: "openai-whisper"),
            "openai-whisper shares the 'openai' key and must not be exclusive"
        )
    }

    func testSharedKeyProviderIsShared() {
        XCTAssertTrue(
            SettingsStore.sttKeyIsShared(for: "openai-whisper"),
            "openai-whisper shares the 'openai' key and must be classified as shared"
        )
    }

    func testExclusiveKeyProviderIsExclusive() {
        // deepgram maps to "deepgram" — its own credential, not shared.
        XCTAssertTrue(
            SettingsStore.sttKeyIsExclusive(for: "deepgram"),
            "deepgram owns its own key and must be classified as exclusive"
        )
    }

    func testExclusiveKeyProviderIsNotShared() {
        XCTAssertFalse(
            SettingsStore.sttKeyIsShared(for: "deepgram"),
            "deepgram owns its own key and must not be classified as shared"
        )
    }

    func testGoogleGeminiKeyIsShared() {
        // google-gemini maps to "gemini" — the credential is shared with
        // other Gemini services, so sttKeyIsShared must be true.
        XCTAssertTrue(
            SettingsStore.sttKeyIsShared(for: "google-gemini"),
            "google-gemini shares the 'gemini' key and must be classified as shared"
        )
    }

    func testGoogleGeminiKeyIsNotExclusive() {
        // google-gemini maps to "gemini" (not "google-gemini"), so the key
        // is shared — sttKeyIsExclusive must be false.
        XCTAssertFalse(
            SettingsStore.sttKeyIsExclusive(for: "google-gemini"),
            "google-gemini shares the 'gemini' key and must not be exclusive"
        )
    }

    func testGoogleGeminiSharedKeyCannotBeResetThroughSTTFlow() {
        // The UI checks sttKeyIsExclusive before allowing the reset action.
        // For google-gemini the guard must prevent the reset because
        // clearing the "gemini" key would break other Gemini services.
        let allowReset = SettingsStore.sttKeyIsExclusive(for: "google-gemini")
        XCTAssertFalse(
            allowReset,
            "The STT reset flow must not be allowed for google-gemini (shared key)"
        )
    }

    func testUnknownProviderDefaultsToExclusive() {
        // Unknown providers fall back to exclusive — clearing an unknown
        // key cannot collide with a known service.
        XCTAssertTrue(
            SettingsStore.sttKeyIsExclusive(for: "future-provider"),
            "Unknown providers should default to exclusive"
        )
    }

    func testUnknownProviderIsNotShared() {
        XCTAssertFalse(
            SettingsStore.sttKeyIsShared(for: "future-provider"),
            "Unknown providers should not be classified as shared"
        )
    }

    // MARK: - Provider Mapping Stability

    /// Ensures that every provider in the STT registry has a consistent
    /// `apiKeyProviderName` mapping. This test fails fast when a new
    /// provider is added with an inconsistent catalog entry.
    func testAllRegistryProvidersHaveStableKeyMapping() {
        let registry = loadSTTProviderRegistry()
        for provider in registry.providers {
            let resolved = SettingsStore.sttApiKeyProviderName(for: provider.id)
            XCTAssertEqual(
                resolved,
                provider.apiKeyProviderName,
                "sttApiKeyProviderName(for: \"\(provider.id)\") returned \"\(resolved)\" "
                + "but the catalog entry specifies \"\(provider.apiKeyProviderName)\""
            )
        }
    }

    /// Ensures the ownership classification for every registered provider
    /// is consistent with the catalog's `apiKeyProviderName` field.
    func testAllRegistryProvidersHaveConsistentOwnership() {
        let registry = loadSTTProviderRegistry()
        for provider in registry.providers {
            let isExclusive = SettingsStore.sttKeyIsExclusive(for: provider.id)
            let expectedExclusive = (provider.apiKeyProviderName == provider.id)
            XCTAssertEqual(
                isExclusive,
                expectedExclusive,
                "Ownership mismatch for \"\(provider.id)\": sttKeyIsExclusive returned "
                + "\(isExclusive) but apiKeyProviderName=\"\(provider.apiKeyProviderName)\" "
                + "implies exclusive=\(expectedExclusive)"
            )
        }
    }

    /// Verifies that shared-key providers cannot be reset through the STT
    /// card — the `sttKeyIsExclusive` guard prevents `clearSTTKey` from
    /// being called for providers whose key is shared with another service.
    func testSharedKeyProviderCannotBeResetThroughSTTFlow() {
        // Simulate what the UI does: check sttKeyIsExclusive before
        // allowing the reset action. For openai-whisper, the guard
        // must prevent the reset.
        let allowReset = SettingsStore.sttKeyIsExclusive(for: "openai-whisper")
        XCTAssertFalse(
            allowReset,
            "The STT reset flow must not be allowed for shared-key providers"
        )
    }

    /// Verifies that exclusive-key providers can be reset through the STT
    /// card without affecting other services.
    func testExclusiveKeyProviderCanBeResetSafely() {
        let allowReset = SettingsStore.sttKeyIsExclusive(for: "deepgram")
        XCTAssertTrue(
            allowReset,
            "The STT reset flow should be allowed for exclusive-key providers"
        )
    }
}
