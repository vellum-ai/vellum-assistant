import SwiftUI
import VellumAssistantShared

/// Voice settings tab — configure push-to-talk activation key,
/// conversation timeout, text-to-speech provider, and speech-to-text provider.
struct VoiceSettingsView: View {
    @ObservedObject var store: SettingsStore

    @AppStorage("activationKey") private var activationKey: String = "fn"
    @AppStorage("voiceConversationTimeoutSeconds") private var conversationTimeoutSeconds: Int = 30
    @AppStorage("ttsProvider") private var ttsProviderRaw: String = "elevenlabs"
    @AppStorage("sttProvider") private var sttProviderRaw: String = ""

    // TTS draft-based state (mirrors Inference card pattern)
    /// Uncommitted provider selection — only persisted on Save.
    @State private var draftTTSProvider: String = "elevenlabs"
    /// API key input field text.
    @State private var ttsApiKeyText: String = ""
    /// Voice ID / reference ID input text.
    @State private var ttsVoiceIdText: String = ""
    /// Baseline voice ID for change detection — set on appear and after save.
    @State private var initialVoiceId: String = ""
    /// Baseline provider for change detection.
    @State private var initialTTSProvider: String = "elevenlabs"
    /// Whether the current TTS provider has a stored API key.
    @State private var ttsProviderHasKey: Bool = false
    /// Save-in-progress indicator.
    @State private var ttsSaving: Bool = false
    /// Error message from key save.
    @State private var ttsSaveError: String? = nil
    /// One-shot player for the TTS test button.
    @State private var testPlayer = TTSTestPlayer()

    @State private var isRecordingCustomKey: Bool = false
    @State private var recordingMonitors: [Any] = []
    @State private var modifierHoldTimer: Timer? = nil

    // STT draft-based state
    /// Uncommitted provider selection — persisted only on Save.
    /// Empty-string sentinel means "no explicit selection" — the UI
    /// resolves the effective provider from the catalog via
    /// `selectedSTTProvider` which falls back to the first registry entry.
    @State private var draftSTTProvider: String = ""
    /// API key input text (replaces the old Connect/Set Up flow).
    @State private var sttApiKeyText: String = ""
    /// Baseline provider for change detection — set on appear and after save.
    @State private var initialSTTProvider: String = ""
    /// Whether the current STT provider already has a stored API key.
    @State private var sttProviderHasKey: Bool = false
    /// Save-in-progress indicator.
    @State private var sttSaving: Bool = false
    /// Error message from key validation / save.
    @State private var sttSaveError: String? = nil

    /// The shared TTS provider registry loaded from the bundled catalog.
    private let ttsRegistry = loadTTSProviderRegistry()

    /// The shared STT provider registry loaded from the bundled catalog.
    private let sttRegistry = loadSTTProviderRegistry()

    /// The currently selected TTS provider entry from the registry, based on
    /// the draft selection. Falls back to the first provider in the registry
    /// if the value does not match any known entry (matching iOS behavior).
    private var selectedTTSProvider: TTSProviderCatalogEntry? {
        ttsRegistry.provider(withId: draftTTSProvider) ?? ttsRegistry.providers.first
    }

    /// The currently selected STT provider entry from the registry, based on
    /// the draft selection. Falls back to the first provider in the registry
    /// if the value does not match any known entry.
    private var selectedSTTProvider: STTProviderCatalogEntry? {
        sttRegistry.provider(withId: draftSTTProvider) ?? sttRegistry.providers.first
    }

    /// Whether the currently selected TTS provider uses a shared API key
    /// (e.g. Deepgram TTS shares the `deepgram` key with Deepgram STT).
    private var ttsProviderUsesSharedKey: Bool {
        SettingsStore.ttsKeyIsShared(for: draftTTSProvider)
    }

    private var currentActivator: PTTActivator {
        // Read activationKey to establish SwiftUI dependency tracking —
        // without this, SwiftUI doesn't know the body depends on this
        // @AppStorage value and skips re-rendering when it changes.
        _ = activationKey
        return PTTActivator.cached
    }

    private var pttEnabled: Bool {
        currentActivator.kind != .none
    }

    /// Preset activators shown as quick-select capsules.
    private let presets: [(label: String, activator: PTTActivator)] = [
        ("Fn", .modifierOnly(flags: .function)),
        ("Ctrl", .modifierOnly(flags: .control)),
        ("Fn+Shift", .modifierOnly(flags: [.function, .shift])),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            pttCard
            conversationTimeoutCard
            ttsProviderCard
            sttProviderCard
        }
        .onDisappear {
            stopRecordingCustomKey()
        }
        .onAppear {
            // Initialize TTS draft state from persisted values
            draftTTSProvider = ttsProviderRaw
            initialTTSProvider = ttsProviderRaw
            ttsProviderHasKey = SettingsStore.ttsCredentialExists(for: ttsProviderRaw)

            // Load the stored voice ID for the current TTS provider so
            // the field reflects the daemon-configured value on page load.
            let voiceId = storedVoiceId(for: ttsProviderRaw)
            ttsVoiceIdText = voiceId
            initialVoiceId = voiceId

            // Initialize STT draft state from persisted values
            draftSTTProvider = sttProviderRaw
            initialSTTProvider = sttProviderRaw
            sttProviderHasKey = sttKeyExists(for: draftSTTProvider)
        }
        .onChange(of: draftTTSProvider) { _, _ in
            // Reset API key field and load the stored voice ID for the
            // newly selected provider so the field shows its current value.
            ttsApiKeyText = ""
            ttsSaveError = nil
            ttsProviderHasKey = SettingsStore.ttsCredentialExists(for: draftTTSProvider)
            let voiceId = storedVoiceId(for: draftTTSProvider)
            ttsVoiceIdText = voiceId
            initialVoiceId = voiceId
        }
        .onChange(of: draftSTTProvider) { _, _ in
            // Clear stale fields when STT provider changes
            sttApiKeyText = ""
            sttSaveError = nil
            sttProviderHasKey = sttKeyExists(for: draftSTTProvider)
        }
        .onChange(of: conversationTimeoutSeconds) {
            VoiceModeManager.conversationTimeoutOverride = conversationTimeoutSeconds
        }
    }

    // MARK: - Push to Talk Card

    private var pttCard: some View {
        SettingsCard(title: "Push to Talk", subtitle: "Hold the activation key to dictate text or start a voice conversation. Uses on-device speech recognition.") {
            VToggle(
                isOn: Binding(
                    get: { pttEnabled },
                    set: { enabled in
                        if enabled {
                            if currentActivator.kind == .none {
                                selectActivator(.modifierOnly(flags: .function))
                            }
                        } else {
                            selectActivator(.off)
                        }
                    }
                ),
                label: "Enable Push to Talk"
            )

            if pttEnabled {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Activation Key:")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)

                    HStack(spacing: VSpacing.sm) {
                        // Preset options
                        ForEach(Array(presets.enumerated()), id: \.offset) { _, preset in
                            let isSelected = currentActivator == preset.activator
                            activationKeyOption(label: preset.label, isSelected: isSelected) {
                                selectActivator(preset.activator)
                            }
                        }

                        // Custom option / recording state
                        if isRecordingCustomKey {
                            activationKeyOption(label: "Press any key...", isSelected: true, isRecording: true) {
                                stopRecordingCustomKey()
                            }
                        } else {
                            let isCustom = !presets.contains(where: { $0.activator == currentActivator })
                            activationKeyOption(
                                label: isCustom ? currentActivator.displayName : "Custom",
                                isSelected: isCustom
                            ) {
                                startRecordingCustomKey()
                            }
                        }
                    }

                    // Show info note when a regular key (not modifier-only, not off) is selected
                    if currentActivator.kind == .key {
                        HStack(alignment: .top, spacing: VSpacing.xs) {
                            VIconView(.info, size: 10)
                                .foregroundStyle(VColor.contentTertiary)
                            Text("This key will still type in other apps while held. For seamless use, a dedicated key (F-key, mouse button) is recommended.")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentTertiary)
                                .lineSpacing(1)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Activation Key Option

    private func activationKeyOption(label: String, isSelected: Bool, isRecording: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: VSpacing.sm) {
                // Radio indicator
                Circle()
                    .fill(isSelected ? VColor.primaryBase : Color.clear)
                    .frame(width: 10, height: 10)
                    .overlay(
                        Circle()
                            .strokeBorder(isSelected ? VColor.primaryBase : VColor.borderHover, lineWidth: 1.5)
                    )

                Text(label)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isSelected ? VColor.surfaceActive : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .strokeBorder(VColor.borderBase, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: VRadius.lg))
        }
        .buttonStyle(.plain)
        .pointerCursor()
    }

    // MARK: - Custom Key Recording

    private func selectActivator(_ newActivator: PTTActivator) {
        stopRecordingCustomKey()
        // Write directly to UserDefaults as JSON (or legacy string for presets).
        // We set the @AppStorage property to the same value so SwiftUI refreshes,
        // avoiding a race where @AppStorage would overwrite the JSON with a sentinel.
        if let legacy = newActivator.legacyString {
            activationKey = legacy
        } else {
            let json = (try? JSONEncoder().encode(newActivator))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "fn"
            activationKey = json
        }
        PTTActivator.updateCache(newActivator)
        NotificationCenter.default.post(name: .activationKeyChanged, object: nil)
    }

    private func startRecordingCustomKey() {
        isRecordingCustomKey = true

        // Monitor flagsChanged for modifier-only detection
        let globalFlags = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [self] event in
            handleRecordingFlagsChanged(event)
        }
        let localFlags = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [self] event in
            handleRecordingFlagsChanged(event)
            return event
        }

        // Monitor keyDown for key or modifier+key
        let globalKeyDown = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [self] event in
            handleRecordingKeyDown(event)
        }
        let localKeyDown = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [self] event in
            if handleRecordingKeyDown(event) {
                return nil // suppress
            }
            return event
        }

        if let m = globalFlags { recordingMonitors.append(m) }
        if let m = localFlags { recordingMonitors.append(m) }
        if let m = globalKeyDown { recordingMonitors.append(m) }
        if let m = localKeyDown { recordingMonitors.append(m) }
    }

    private func stopRecordingCustomKey() {
        isRecordingCustomKey = false
        modifierHoldTimer?.invalidate()
        modifierHoldTimer = nil
        for monitor in recordingMonitors {
            NSEvent.removeMonitor(monitor)
        }
        recordingMonitors = []
    }

    private func handleRecordingFlagsChanged(_ event: NSEvent) {
        // Cancel any pending modifier-only timer
        modifierHoldTimer?.invalidate()
        modifierHoldTimer = nil

        let relevant: NSEvent.ModifierFlags = [.command, .shift, .control, .option, .function]
        let held = event.modifierFlags.intersection(relevant)

        guard !held.isEmpty else { return }

        // Start a 500ms timer: if no keyDown arrives, accept as modifier-only
        modifierHoldTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [self] _ in
            let activator = PTTActivator.modifierOnly(flags: held)
            selectActivator(activator)
        }
    }

    /// Returns true if the event was consumed (should be suppressed in local monitor).
    @discardableResult
    private func handleRecordingKeyDown(_ event: NSEvent) -> Bool {
        guard !event.isARepeat else { return false }

        // Escape cancels recording
        if event.keyCode == 53 {
            stopRecordingCustomKey()
            return true
        }

        // Cancel modifier-only timer since a key was pressed
        modifierHoldTimer?.invalidate()
        modifierHoldTimer = nil

        let relevant: NSEvent.ModifierFlags = [.command, .shift, .control, .option, .function]
        let held = event.modifierFlags.intersection(relevant)

        let activator: PTTActivator
        if held.isEmpty {
            activator = .key(code: event.keyCode)
        } else {
            activator = .modifierKey(code: event.keyCode, flags: held)
        }

        selectActivator(activator)
        return true
    }

    // MARK: - Conversation Timeout Card

    private var conversationTimeoutCard: some View {
        SettingsCard(title: "Conversation Timeout", subtitle: "How long to wait for follow-up speech before ending a voice conversation.") {
            VDropdown(
                placeholder: "Select timeout\u{2026}",
                selection: $conversationTimeoutSeconds,
                options: timeoutOptions,
                maxWidth: 400
            )
            .accessibilityLabel("Conversation timeout duration")
        }
    }

    private let timeoutOptions: [(label: String, value: Int)] = [
        (label: "5 seconds", value: 5),
        (label: "10 seconds", value: 10),
        (label: "15 seconds", value: 15),
        (label: "30 seconds", value: 30),
        (label: "60 seconds", value: 60),
    ]

    // MARK: - Unified TTS Provider Card

    /// Whether the user has made changes worth saving in the TTS card.
    private var ttsHasChanges: Bool {
        let providerChanged = draftTTSProvider != initialTTSProvider
        let hasNewKey = !ttsApiKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let voiceIdChanged = ttsVoiceIdText.trimmingCharacters(in: .whitespacesAndNewlines) != initialVoiceId
        return providerChanged || hasNewKey || voiceIdChanged
    }

    /// Whether the TTS reset button should be shown for the current provider.
    ///
    /// The reset button is only shown when:
    /// 1. A key already exists for the provider, AND
    /// 2. The provider owns its key exclusively (not shared with another
    ///    service like STT).
    ///
    /// This prevents accidental clearing of shared credentials — e.g.
    /// resetting Deepgram TTS must not delete the `deepgram` key that
    /// STT also depends on.
    private var ttsResetAllowed: Bool {
        ttsProviderHasKey && SettingsStore.ttsKeyIsExclusive(for: draftTTSProvider)
    }

    /// Phrase synthesized when the Test button is tapped. Uses the active
    /// assistant's lockfile name so the user hears their assistant's name
    /// spoken in the configured voice.
    private var ttsTestPhrase: String {
        let name = LockfileAssistant.loadActiveAssistantId() ?? "your assistant"
        return "Hey! It's \(name). How does this sound?"
    }

    private var ttsProviderCard: some View {
        SettingsCard(title: "Text-to-Speech", subtitle: "Choose a TTS provider for voice conversations and read-aloud. The selected provider is used globally across all speech features.") {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                // Provider dropdown — data-driven from the shared registry
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Provider")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    VDropdown(
                        placeholder: "Select a provider\u{2026}",
                        selection: $draftTTSProvider,
                        options: ttsRegistry.providers.map { entry in
                            (label: entry.displayName, value: entry.id)
                        }
                    )
                }

                // Shared-key explanatory note for providers like Deepgram
                // that reuse an API key with another service (e.g. STT).
                ttsSharedKeyNote

                // API key field — always shown so shared-key providers
                // (e.g. Deepgram TTS) can be configured even when the
                // sibling STT provider is set to something else.
                ttsApiKeyField

                // Voice ID / Reference ID field (provider-specific) —
                // hidden for providers like Deepgram that use a built-in
                // default model and do not expose voice selection.
                ttsVoiceIdField

                // Credentials guide — contextual help for obtaining an API key
                ttsCredentialsGuideView

                HStack(spacing: VSpacing.sm) {
                    VButton(
                        label: testPlayer.isLoading ? "Testing\u{2026}" : "Test",
                        style: .outlined,
                        isDisabled: false
                    ) {
                        Task { await testPlayer.playTest(text: ttsTestPhrase) }
                    }

                    ServiceCardActions(
                        hasChanges: ttsHasChanges,
                        isSaving: ttsSaving,
                        onSave: { saveTTS() },
                        savingLabel: "Saving...",
                        onReset: {
                            store.clearTTSKey(ttsProviderId: draftTTSProvider)
                            ttsProviderHasKey = false
                            ttsApiKeyText = ""
                        },
                        showReset: ttsResetAllowed
                    )
                }

                if let testError = testPlayer.error {
                    VInlineMessage(testError, tone: .error)
                }
            }
        }
    }

    // MARK: - TTS Shared Key Note

    @ViewBuilder
    private var ttsSharedKeyNote: some View {
        if ttsProviderUsesSharedKey {
            HStack(alignment: .top, spacing: VSpacing.xs) {
                VIconView(.info, size: 10)
                    .foregroundStyle(VColor.contentTertiary)
                Text("This API key is shared with \(selectedTTSProvider?.displayName ?? "the provider") speech-to-text.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineSpacing(1)
            }
        }
    }

    // MARK: - TTS API Key Field

    private var ttsApiKeyField: some View {
        APIKeyTextField(
            label: "\(selectedTTSProvider?.displayName ?? "Provider") API Key",
            hasKey: ttsProviderHasKey,
            text: $ttsApiKeyText,
            errorMessage: ttsSaveError
        )
        .disabled(ttsSaving)
    }

    // MARK: - TTS Voice ID Field

    @ViewBuilder
    private var ttsVoiceIdField: some View {
        if selectedTTSProvider?.supportsVoiceSelection == true {
            VTextField(
                "Voice ID",
                placeholder: "\(selectedTTSProvider?.displayName ?? "Provider") Voice ID (optional)",
                text: $ttsVoiceIdText
            )
        }
    }

    // MARK: - TTS Credentials Guide

    @ViewBuilder
    private var ttsCredentialsGuideView: some View {
        if let guide = selectedTTSProvider?.credentialsGuide,
           let attributed = try? AttributedString(
               markdown: "\(guide.description) [\(guide.linkLabel)](\(guide.url))"
           ) {
            Text(attributed)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
                .tint(VColor.primaryBase)
                .lineSpacing(1)
                .environment(\.openURL, OpenURLAction { url in
                    NSWorkspace.shared.open(url)
                    return .handled
                })
        }
    }

    // MARK: - TTS Save / Helpers

    /// Persists the TTS provider, API key, and voice ID atomically.
    private func saveTTS() {
        ttsSaving = true
        ttsSaveError = nil

        // Persist provider if changed
        if draftTTSProvider != ttsProviderRaw {
            store.setTTSProvider(draftTTSProvider)
            ttsProviderRaw = draftTTSProvider
        }

        // Always persist voice ID for the selected provider, even when
        // empty — sending an empty string clears a previously set voice
        // ID and reverts to the provider's default voice.
        let trimmedVoiceId = ttsVoiceIdText.trimmingCharacters(in: .whitespacesAndNewlines)
        switch draftTTSProvider {
        case "elevenlabs":
            store.setElevenLabsVoiceId(trimmedVoiceId)
        case "fish-audio":
            store.setFishAudioReferenceId(trimmedVoiceId)
        default:
            break
        }

        // Persist API key if entered. Shared-key providers (e.g. Deepgram)
        // route through APIKeyManager which stores the key under the
        // canonical provider name, so both TTS and STT pick it up.
        let trimmedKey = ttsApiKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedKey.isEmpty {
            ttsApiKeyText = ""
            ttsProviderHasKey = true
            store.saveTTSKey(trimmedKey, ttsProviderId: draftTTSProvider)
        }

        ttsSaving = false

        // Update baseline for change detection
        initialTTSProvider = draftTTSProvider
        initialVoiceId = trimmedVoiceId
    }

    /// Returns the stored voice ID / reference ID for the given TTS provider
    /// from the daemon-synced values on `SettingsStore`.
    private func storedVoiceId(for provider: String) -> String {
        switch provider {
        case "elevenlabs":
            return store.elevenLabsVoiceId
        case "fish-audio":
            return store.fishAudioReferenceId
        default:
            return ""
        }
    }

    /// Checks whether an API key exists for the given STT provider by
    /// resolving the provider's `apiKeyProviderName` from the registry.
    private func sttKeyExists(for sttProviderId: String) -> Bool {
        let keyProvider = SettingsStore.sttApiKeyProviderName(for: sttProviderId)
        return APIKeyManager.getKey(for: keyProvider) != nil
    }

    // MARK: - STT Key Ownership Helpers

    /// Whether the STT reset button should be shown for the current provider.
    ///
    /// The reset button is only shown when:
    /// 1. A key already exists for the provider, AND
    /// 2. The provider owns its key exclusively (not shared with another
    ///    service like Inference).
    ///
    /// This prevents accidental clearing of shared credentials — e.g.
    /// resetting `openai-whisper` must not delete the `openai` key that
    /// Inference also depends on.
    ///
    /// Provider-agnostic: adding a third STT provider only requires a
    /// catalog entry, not a new conditional here.
    private var sttResetAllowed: Bool {
        sttProviderHasKey && SettingsStore.sttKeyIsExclusive(for: draftSTTProvider)
    }

    // MARK: - STT Provider Card

    /// True when the user has made changes worth saving in the STT card.
    private var sttHasChanges: Bool {
        let providerChanged = draftSTTProvider != initialSTTProvider
        let hasNewKey = !sttApiKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return providerChanged || hasNewKey
    }

    private var sttProviderCard: some View {
        SettingsCard(title: "Speech-to-Text", subtitle: "Choose an STT provider for audio transcription. The selected provider is used globally across all transcription features.") {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                // Provider dropdown — data-driven from the shared STT registry
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Provider")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    VDropdown(
                        placeholder: "Select a provider\u{2026}",
                        selection: $draftSTTProvider,
                        options: sttRegistry.providers.map { entry in
                            (label: entry.displayName, value: entry.id)
                        }
                    )
                }

                // API key field — label and placeholder adapt to the selected provider
                sttApiKeyField

                // Credentials guide — contextual help for obtaining an API key
                sttCredentialsGuideView

                // Save + Reset actions — reset is only shown for
                // exclusive-key providers to avoid clearing shared
                // credentials (e.g. `openai` used by both Inference and
                // Whisper STT).
                ServiceCardActions(
                    hasChanges: sttHasChanges,
                    isSaving: sttSaving,
                    onSave: { saveSTT() },
                    savingLabel: "Saving...",
                    onReset: { resetSTTKey() },
                    showReset: sttResetAllowed
                )

                if let sttSaveError {
                    VInlineMessage(sttSaveError, tone: .error)
                }
            }
        }
    }

    // MARK: - STT API Key Field

    private var sttApiKeyField: some View {
        APIKeyTextField(
            label: "\(selectedSTTProvider?.displayName ?? "Provider") API Key",
            hasKey: sttProviderHasKey,
            text: $sttApiKeyText
        )
        .disabled(sttSaving)
    }

    // MARK: - STT Credentials Guide

    @ViewBuilder
    private var sttCredentialsGuideView: some View {
        if let guide = selectedSTTProvider?.credentialsGuide,
           let attributed = try? AttributedString(
               markdown: "\(guide.description) [\(guide.linkLabel)](\(guide.url))"
           ) {
            Text(attributed)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
                .tint(VColor.primaryBase)
                .lineSpacing(1)
                .environment(\.openURL, OpenURLAction { url in
                    NSWorkspace.shared.open(url)
                    return .handled
                })
        }
    }

    // MARK: - STT Reset

    /// Clears the STT API key for the current draft provider and resets the
    /// associated UI state. Only called for exclusive-key providers — shared
    /// credentials are never cleared through the STT settings card.
    private func resetSTTKey() {
        store.clearSTTKey(sttProviderId: draftSTTProvider)
        sttProviderHasKey = false
        sttApiKeyText = ""
    }

    // MARK: - STT Save

    private func saveSTT() {
        sttSaving = true
        sttSaveError = nil

        // Normalize the empty sentinel to the resolved provider so we never
        // persist an empty string as the STT provider identifier.
        if draftSTTProvider.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let resolved = selectedSTTProvider?.id {
            draftSTTProvider = resolved
        }

        let providerToSave = draftSTTProvider
        let providerChanged = providerToSave != sttProviderRaw
        let trimmedKey = sttApiKeyText.trimmingCharacters(in: .whitespacesAndNewlines)

        Task {
            var providerSaveSucceeded = true
            var keySaveSucceeded = true

            if providerChanged {
                providerSaveSucceeded = await store.setSTTProvider(providerToSave).value
                if providerSaveSucceeded {
                    sttProviderRaw = providerToSave
                } else {
                    sttSaveError = "Could not save speech-to-text provider selection. Please try again."
                }
            }

            if !trimmedKey.isEmpty {
                let keyResult = await store.saveSTTKeyResult(
                    trimmedKey,
                    sttProviderId: providerToSave
                )
                keySaveSucceeded = keyResult.success
                if keyResult.success {
                    sttApiKeyText = ""
                    sttProviderHasKey = true
                } else {
                    sttSaveError = keyResult.error
                        ?? "Could not save speech-to-text API key. Please try again."
                }
            }

            if providerSaveSucceeded {
                initialSTTProvider = providerToSave
            }

            if providerSaveSucceeded && keySaveSucceeded {
                sttSaveError = nil
            } else if !providerSaveSucceeded && !keySaveSucceeded {
                sttSaveError = "Could not save speech-to-text settings. Please try again."
            }

            sttSaving = false
        }
    }
}
