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

    func testDeepgramSTTKeyIsNotExclusive() {
        // deepgram STT maps to "deepgram" — but deepgram TTS also uses the
        // same "deepgram" key, so it is shared across services.
        XCTAssertFalse(
            SettingsStore.sttKeyIsExclusive(for: "deepgram"),
            "deepgram STT shares the 'deepgram' key with TTS and must not be exclusive"
        )
    }

    func testDeepgramSTTKeyIsShared() {
        // deepgram STT shares the "deepgram" key with deepgram TTS.
        XCTAssertTrue(
            SettingsStore.sttKeyIsShared(for: "deepgram"),
            "deepgram STT shares the 'deepgram' key with TTS and must be classified as shared"
        )
    }

    func testDeepgramSTTSharedKeyCannotBeResetThroughSTTFlow() {
        // The UI checks sttKeyIsExclusive before allowing the reset action.
        // For deepgram the guard must prevent the reset because clearing the
        // "deepgram" key would break TTS.
        let allowReset = SettingsStore.sttKeyIsExclusive(for: "deepgram")
        XCTAssertFalse(
            allowReset,
            "The STT reset flow must not be allowed for deepgram (shared key with TTS)"
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
    /// is consistent: a provider is exclusive only when its key name matches
    /// its id AND no TTS provider shares the same key.
    func testAllRegistryProvidersHaveConsistentOwnership() {
        let sttRegistry = loadSTTProviderRegistry()
        let ttsRegistry = loadTTSProviderRegistry()
        for provider in sttRegistry.providers {
            let isExclusive = SettingsStore.sttKeyIsExclusive(for: provider.id)
            let nameMatchesId = (provider.apiKeyProviderName == provider.id)
            let ttsSharesKey = ttsRegistry.providers.contains { ttsEntry in
                guard ttsEntry.credentialMode == .apiKey else { return false }
                return (ttsEntry.apiKeyProviderName ?? ttsEntry.id) == provider.apiKeyProviderName
            }
            let expectedExclusive = nameMatchesId && !ttsSharesKey
            XCTAssertEqual(
                isExclusive,
                expectedExclusive,
                "Ownership mismatch for \"\(provider.id)\": sttKeyIsExclusive returned "
                + "\(isExclusive) but expected \(expectedExclusive) "
                + "(apiKeyProviderName=\"\(provider.apiKeyProviderName)\", ttsSharesKey=\(ttsSharesKey))"
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
    /// card without affecting other services. No current catalog provider is
    /// exclusive (deepgram is shared with TTS, openai-whisper and
    /// google-gemini map to shared key names), so we use an unknown provider
    /// which defaults to exclusive per `sttKeyIsExclusive` semantics.
    func testExclusiveKeyProviderCanBeResetSafely() {
        let allowReset = SettingsStore.sttKeyIsExclusive(for: "future-provider")
        XCTAssertTrue(
            allowReset,
            "The STT reset flow should be allowed for exclusive-key providers"
        )
    }

    // MARK: - STT Default Selection (Empty Sentinel)

    /// When no STT provider has been persisted, the UserDefaults key should
    /// be absent (or empty). The UI resolves the effective provider from the
    /// catalog's first entry via `selectedSTTProvider`.
    func testDefaultSTTProviderIsEmpty() {
        UserDefaults.standard.removeObject(forKey: "sttProvider")

        let raw = UserDefaults.standard.string(forKey: "sttProvider")
        XCTAssertNil(
            raw,
            "With no persisted value the sttProvider key should be nil"
        )
    }

    /// The STT service configuration check must return false when the
    /// provider key is an empty string (the new default sentinel).
    func testEmptySTTProviderIsNotConsideredConfigured() {
        UserDefaults.standard.set("", forKey: "sttProvider")

        XCTAssertFalse(
            STTProviderRegistry.isServiceConfigured,
            "An empty sttProvider value must not be treated as configured"
        )
    }

    /// Streaming availability must be false when the STT provider key is
    /// the empty-string sentinel.
    func testEmptySTTProviderReportsNoStreamingAvailable() {
        UserDefaults.standard.set("", forKey: "sttProvider")

        XCTAssertFalse(
            STTProviderRegistry.isStreamingAvailable,
            "An empty sttProvider must not report streaming as available"
        )
    }

    // MARK: - STT Persistence After Explicit Selection

    /// After explicitly setting a provider via `setSTTProvider`, the value
    /// should be persisted so subsequent reads return it.
    func testExplicitSTTProviderSelectionPersists() {
        UserDefaults.standard.removeObject(forKey: "sttProvider")

        store.setSTTProvider("deepgram")
        waitForPatchCount(1)

        // The store persists via config patch; simulate the daemon echoing
        // the value back through applyDaemonConfig.
        let config: [String: Any] = [
            "services": ["stt": ["provider": "deepgram"]]
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
            "Explicitly selected provider must be persisted after daemon sync"
        )
    }

    // MARK: - Daemon Sync Does Not Clobber With Empty Values

    /// When the daemon sends an empty provider string the existing persisted
    /// value must not be overwritten.
    func testApplyDaemonConfigDoesNotClobberWithEmptyProvider() {
        UserDefaults.standard.set("deepgram", forKey: "sttProvider")

        let config: [String: Any] = [
            "services": [
                "stt": [
                    "provider": ""
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
            "Empty daemon provider value must not overwrite the persisted selection"
        )
    }

    /// When the daemon sends a whitespace-only provider string the existing
    /// persisted value must not be overwritten.
    func testApplyDaemonConfigDoesNotClobberWithWhitespaceProvider() {
        UserDefaults.standard.set("openai-whisper", forKey: "sttProvider")

        let config: [String: Any] = [
            "services": [
                "stt": [
                    "provider": "  "
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
            "Whitespace-only daemon provider value must not overwrite the persisted selection"
        )
    }

    // MARK: - Existing User-Selected Provider Behavior Preserved

    /// A user who previously selected openai-whisper and has it persisted
    /// must continue to see that value after daemon sync confirms it.
    func testPreExistingOpenAIWhisperSelectionSurvivesDaemonSync() {
        UserDefaults.standard.set("openai-whisper", forKey: "sttProvider")

        let config: [String: Any] = [
            "services": [
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

        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "sttProvider"),
            "openai-whisper",
            "Pre-existing user selection must survive daemon sync"
        )
    }

    /// STT service configuration check must return true when a valid
    /// provider is persisted.
    func testPersistedSTTProviderIsConsideredConfigured() {
        UserDefaults.standard.set("deepgram", forKey: "sttProvider")

        XCTAssertTrue(
            STTProviderRegistry.isServiceConfigured,
            "A non-empty persisted sttProvider must be treated as configured"
        )
    }

    // MARK: - Deepgram TTS Provider Selection

    func testSetTTSProviderDeepgramEmitsExpectedPatch() {
        store.setTTSProvider("deepgram")

        waitForPatchCount(1)

        let patch = lastTTSPatch()
        XCTAssertNotNil(patch, "expected a services.tts patch payload for deepgram")
        XCTAssertEqual(patch?["provider"] as? String, "deepgram")
    }

    func testSetTTSProviderDeepgramDoesNotEmitSTTPatch() {
        store.setTTSProvider("deepgram")

        waitForPatchCount(1)

        let sttPatch = lastSTTPatch()
        XCTAssertNil(sttPatch, "setTTSProvider(deepgram) must not emit an STT patch")
    }

    func testApplyDaemonConfigSyncsDeepgramTTSProvider() {
        UserDefaults.standard.removeObject(forKey: "ttsProvider")

        let config: [String: Any] = [
            "services": [
                "tts": [
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
            UserDefaults.standard.string(forKey: "ttsProvider"),
            "deepgram"
        )
    }

    func testApplyDaemonConfigSyncsDeepgramTTSWithExistingElevenLabs() {
        UserDefaults.standard.set("elevenlabs", forKey: "ttsProvider")

        let config: [String: Any] = [
            "services": [
                "tts": [
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
            UserDefaults.standard.string(forKey: "ttsProvider"),
            "deepgram",
            "Daemon config should overwrite the persisted TTS provider"
        )
    }

    func testSequentialTTSProviderPatchesIncludingDeepgram() {
        store.setTTSProvider("elevenlabs")
        waitForPatchCount(1)

        store.setTTSProvider("deepgram")
        waitForPatchCount(2)

        let patch = lastTTSPatch()
        XCTAssertEqual(
            patch?["provider"] as? String,
            "deepgram",
            "Most recent TTS patch should reflect the deepgram provider"
        )
    }

    // MARK: - TTS Key Ownership Semantics

    func testTTSElevenLabsKeyIsExclusive() {
        // ElevenLabs uses credential mode with its own namespace — always exclusive.
        XCTAssertTrue(
            SettingsStore.ttsKeyIsExclusive(for: "elevenlabs"),
            "ElevenLabs TTS owns its own credential namespace and must be exclusive"
        )
    }

    func testTTSElevenLabsKeyIsNotShared() {
        XCTAssertFalse(
            SettingsStore.ttsKeyIsShared(for: "elevenlabs"),
            "ElevenLabs TTS must not be classified as shared"
        )
    }

    func testTTSFishAudioKeyIsExclusive() {
        // Fish Audio uses credential mode with its own namespace — always exclusive.
        XCTAssertTrue(
            SettingsStore.ttsKeyIsExclusive(for: "fish-audio"),
            "Fish Audio TTS owns its own credential namespace and must be exclusive"
        )
    }

    func testTTSFishAudioKeyIsNotShared() {
        XCTAssertFalse(
            SettingsStore.ttsKeyIsShared(for: "fish-audio"),
            "Fish Audio TTS must not be classified as shared"
        )
    }

    func testTTSDeepgramKeyIsShared() {
        // Deepgram TTS uses api-key mode with apiKeyProviderName "deepgram",
        // which is also used by Deepgram STT — the key is shared.
        XCTAssertTrue(
            SettingsStore.ttsKeyIsShared(for: "deepgram"),
            "Deepgram TTS shares the 'deepgram' key with STT and must be classified as shared"
        )
    }

    func testTTSDeepgramKeyIsNotExclusive() {
        XCTAssertFalse(
            SettingsStore.ttsKeyIsExclusive(for: "deepgram"),
            "Deepgram TTS shares the 'deepgram' key with STT and must not be exclusive"
        )
    }

    func testTTSDeepgramSharedKeyCannotBeResetThroughTTSFlow() {
        // The UI checks ttsKeyIsExclusive before allowing the reset action.
        // For deepgram the guard must prevent the reset because clearing the
        // "deepgram" key would break STT.
        let allowReset = SettingsStore.ttsKeyIsExclusive(for: "deepgram")
        XCTAssertFalse(
            allowReset,
            "The TTS reset flow must not be allowed for deepgram (shared key with STT)"
        )
    }

    func testTTSUnknownProviderDefaultsToExclusive() {
        XCTAssertTrue(
            SettingsStore.ttsKeyIsExclusive(for: "future-tts-provider"),
            "Unknown TTS providers should default to exclusive"
        )
    }

    func testTTSUnknownProviderIsNotShared() {
        XCTAssertFalse(
            SettingsStore.ttsKeyIsShared(for: "future-tts-provider"),
            "Unknown TTS providers should not be classified as shared"
        )
    }

    // MARK: - TTS Credential Exists (Registry-Driven)

    func testTTSCredentialExistsReturnsFalseForUnknownProvider() {
        XCTAssertFalse(
            SettingsStore.ttsCredentialExists(for: "nonexistent-provider"),
            "Unknown TTS provider must return false for credential existence"
        )
    }

    // MARK: - TTS + STT Deepgram Coexistence

    func testApplyDaemonConfigSyncsBothDeepgramTTSAndSTT() {
        UserDefaults.standard.removeObject(forKey: "ttsProvider")
        UserDefaults.standard.removeObject(forKey: "sttProvider")

        let config: [String: Any] = [
            "services": [
                "tts": [
                    "provider": "deepgram"
                ],
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
            UserDefaults.standard.string(forKey: "ttsProvider"),
            "deepgram",
            "TTS provider must be synced to deepgram"
        )
        XCTAssertEqual(
            UserDefaults.standard.string(forKey: "sttProvider"),
            "deepgram",
            "STT provider must be synced to deepgram"
        )
    }

    func testSetTTSProviderDeepgramAndSTTProviderDeepgramEmitSeparatePatches() {
        store.setTTSProvider("deepgram")
        waitForPatchCount(1)

        store.setSTTProvider("deepgram")
        waitForPatchCount(2)

        // Verify the TTS patch
        let ttsPatch = lastTTSPatch()
        XCTAssertEqual(ttsPatch?["provider"] as? String, "deepgram")

        // Verify the STT patch
        let sttPatch = lastSTTPatch()
        XCTAssertEqual(sttPatch?["provider"] as? String, "deepgram")
    }

    // MARK: - TTS Provider Registry Consistency

    /// Ensures every TTS provider in the registry has the expected credential
    /// metadata fields set. This test fails fast when a new provider is added
    /// with incomplete credential metadata.
    func testAllTTSRegistryProvidersHaveCredentialMetadata() {
        let registry = loadTTSProviderRegistry()
        for provider in registry.providers {
            switch provider.credentialMode {
            case .credential:
                XCTAssertNotNil(
                    provider.credentialNamespace,
                    "Credential-mode TTS provider \"\(provider.id)\" must have a credentialNamespace"
                )
            case .apiKey:
                XCTAssertNotNil(
                    provider.apiKeyProviderName,
                    "Api-key-mode TTS provider \"\(provider.id)\" must have an apiKeyProviderName"
                )
            }
        }
    }

    /// Ensures the TTS key ownership classification is consistent with the
    /// provider's credential mode and metadata.
    func testAllTTSRegistryProvidersHaveConsistentOwnership() {
        let registry = loadTTSProviderRegistry()
        for provider in registry.providers {
            let isExclusive = SettingsStore.ttsKeyIsExclusive(for: provider.id)
            let isShared = SettingsStore.ttsKeyIsShared(for: provider.id)
            XCTAssertNotEqual(
                isExclusive,
                isShared,
                "TTS provider \"\(provider.id)\" must be either exclusive or shared, not both"
            )
        }
    }
}
