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

        // Seed provider registries with two dummy providers each.
        // These are intentionally NOT real provider values — tests should
        // not give the impression that the seed data must stay in sync
        // with the actual catalog.
        _seedSTTProviderRegistryForTesting(Self.buildSTTTestRegistry())
        _seedTTSProviderRegistryForTesting(TTSProviderRegistry(providers: [
            TTSProviderCatalogEntry(
                id: "tts-exclusive",
                displayName: "TTS Exclusive",
                subtitle: "Dummy exclusive TTS provider.",
                setupMode: .cli,
                setupHint: "Run setup.",
                credentialMode: .credential,
                credentialNamespace: "tts-exclusive",
                apiKeyProviderName: nil,
                supportsVoiceSelection: false,
                credentialsGuide: nil
            ),
            TTSProviderCatalogEntry(
                id: "tts-shared",
                displayName: "TTS Shared",
                subtitle: "Dummy shared TTS provider.",
                setupMode: .cli,
                setupHint: "Run setup.",
                credentialMode: .apiKey,
                credentialNamespace: nil,
                apiKeyProviderName: "shared-key",
                supportsVoiceSelection: false,
                credentialsGuide: nil
            ),
        ]))
    }

    override func tearDown() {
        store = nil
        mockSettingsClient = nil
        _seedSTTProviderRegistryForTesting(STTProviderRegistry(providers: []))
        _seedTTSProviderRegistryForTesting(TTSProviderRegistry(providers: []))
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

    /// Builds a test STT provider registry with two dummy providers.
    /// Uses JSON decoding because STTProviderCatalogEntry has no memberwise init.
    private static func buildSTTTestRegistry() -> STTProviderRegistry {
        let json = """
        {
            "providers": [
                {
                    "id": "stt-exclusive",
                    "displayName": "STT Exclusive",
                    "subtitle": "Dummy exclusive STT provider.",
                    "setupMode": "api-key",
                    "setupHint": "Enter your key.",
                    "apiKeyProviderName": "stt-exclusive",
                    "conversationStreamingMode": "none"
                },
                {
                    "id": "stt-shared",
                    "displayName": "STT Shared",
                    "subtitle": "Dummy shared STT provider.",
                    "setupMode": "api-key",
                    "setupHint": "Enter your key.",
                    "apiKeyProviderName": "shared-key",
                    "conversationStreamingMode": "none"
                }
            ]
        }
        """
        return try! JSONDecoder().decode(STTProviderRegistry.self, from: json.data(using: .utf8)!)
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

    func testSTTApiKeyProviderNameResolvesRegisteredProvider() {
        let keyName = SettingsStore.sttApiKeyProviderName(for: "stt-shared")
        XCTAssertEqual(keyName, "shared-key")
    }

    func testSTTApiKeyProviderNameResolvesExclusiveProvider() {
        let keyName = SettingsStore.sttApiKeyProviderName(for: "stt-exclusive")
        XCTAssertEqual(keyName, "stt-exclusive")
    }

    func testSTTApiKeyProviderNameFallsBackToProviderIdForUnknown() {
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

    // MARK: - STT Key Ownership Semantics

    func testSTTSharedKeyProviderIsNotExclusive() {
        // stt-shared uses apiKeyProviderName "shared-key" which also
        // appears in the TTS registry — cross-service shared.
        XCTAssertFalse(
            SettingsStore.sttKeyIsExclusive(for: "stt-shared"),
            "Shared-key STT provider must not be exclusive"
        )
    }

    func testSTTSharedKeyProviderIsShared() {
        XCTAssertTrue(
            SettingsStore.sttKeyIsShared(for: "stt-shared"),
            "Shared-key STT provider must be classified as shared"
        )
    }

    func testSTTExclusiveKeyProviderIsExclusive() {
        // stt-exclusive uses apiKeyProviderName "stt-exclusive" which
        // matches its id and is not present in the TTS registry.
        XCTAssertTrue(
            SettingsStore.sttKeyIsExclusive(for: "stt-exclusive"),
            "Exclusive-key STT provider must be exclusive"
        )
    }

    func testSTTExclusiveKeyProviderIsNotShared() {
        XCTAssertFalse(
            SettingsStore.sttKeyIsShared(for: "stt-exclusive"),
            "Exclusive-key STT provider must not be classified as shared"
        )
    }

    func testSTTSharedKeyCannotBeResetThroughSTTFlow() {
        let allowReset = SettingsStore.sttKeyIsExclusive(for: "stt-shared")
        XCTAssertFalse(
            allowReset,
            "The STT reset flow must not be allowed for shared-key providers"
        )
    }

    func testSTTUnknownProviderDefaultsToExclusive() {
        XCTAssertTrue(
            SettingsStore.sttKeyIsExclusive(for: "future-provider"),
            "Unknown providers should default to exclusive"
        )
    }

    func testSTTUnknownProviderIsNotShared() {
        XCTAssertFalse(
            SettingsStore.sttKeyIsShared(for: "future-provider"),
            "Unknown providers should not be classified as shared"
        )
    }

    func testSTTExclusiveKeyProviderCanBeResetSafely() {
        let allowReset = SettingsStore.sttKeyIsExclusive(for: "stt-exclusive")
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

    func testTTSExclusiveKeyProviderIsExclusive() {
        // tts-exclusive uses credential mode with its own namespace — always exclusive.
        XCTAssertTrue(
            SettingsStore.ttsKeyIsExclusive(for: "tts-exclusive"),
            "Credential-mode TTS provider must be exclusive"
        )
    }

    func testTTSExclusiveKeyProviderIsNotShared() {
        XCTAssertFalse(
            SettingsStore.ttsKeyIsShared(for: "tts-exclusive"),
            "Credential-mode TTS provider must not be classified as shared"
        )
    }

    func testTTSSharedKeyProviderIsShared() {
        // tts-shared uses api-key mode with apiKeyProviderName "shared-key",
        // which also appears in the STT registry — cross-service shared.
        XCTAssertTrue(
            SettingsStore.ttsKeyIsShared(for: "tts-shared"),
            "Shared-key TTS provider must be classified as shared"
        )
    }

    func testTTSSharedKeyProviderIsNotExclusive() {
        XCTAssertFalse(
            SettingsStore.ttsKeyIsExclusive(for: "tts-shared"),
            "Shared-key TTS provider must not be exclusive"
        )
    }

    func testTTSSharedKeyCannotBeResetThroughTTSFlow() {
        let allowReset = SettingsStore.ttsKeyIsExclusive(for: "tts-shared")
        XCTAssertFalse(
            allowReset,
            "The TTS reset flow must not be allowed for shared-key providers"
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

    /// Ensures the TTS key ownership classification is consistent: every
    /// seeded provider must be either exclusive or shared, never both.
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
