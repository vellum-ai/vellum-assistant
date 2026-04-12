import SwiftUI
import VellumAssistantShared

/// Voice settings tab — configure push-to-talk activation key,
/// conversation timeout, and text-to-speech provider.
struct VoiceSettingsView: View {
    @ObservedObject var store: SettingsStore

    @AppStorage("activationKey") private var activationKey: String = "fn"
    @AppStorage("voiceConversationTimeoutSeconds") private var conversationTimeoutSeconds: Int = 30
    @AppStorage("ttsProvider") private var ttsProviderRaw: String = "elevenlabs"

    @State private var elevenLabsKeyText: String = ""
    @State private var ttsSetupExpanded: Bool = false
    /// Whether an ElevenLabs API key is stored (fetched per-component).
    @State private var elevenLabsHasKey = false
    @State private var isRecordingCustomKey: Bool = false
    @State private var recordingMonitors: [Any] = []
    @State private var modifierHoldTimer: Timer? = nil

    /// The shared TTS provider registry loaded from the bundled catalog.
    private let registry = loadTTSProviderRegistry()

    /// The currently selected provider entry from the registry.
    private var selectedProvider: TTSProviderCatalogEntry? {
        registry.provider(withId: ttsProviderRaw)
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
        }
        .onDisappear {
            stopRecordingCustomKey()
        }
        .onAppear {
            elevenLabsHasKey = APIKeyManager.getKey(for: "elevenlabs") != nil
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

    private var ttsProviderCard: some View {
        SettingsCard(title: "Text-to-Speech", subtitle: "Choose a TTS provider for voice conversations and read-aloud. The selected provider is used globally across all speech features.") {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                // Provider selector — data-driven from the shared registry
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Provider:")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)

                    HStack(spacing: VSpacing.sm) {
                        ForEach(registry.providers, id: \.id) { entry in
                            let isSelected = ttsProviderRaw == entry.id
                            providerOption(label: entry.displayName, isSelected: isSelected) {
                                ttsProviderRaw = entry.id
                                store.setTTSProvider(entry.id)
                            }
                        }
                    }
                }

                // Provider-specific subtitle from registry metadata
                if let provider = selectedProvider {
                    Text(provider.subtitle)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }

                // Provider-specific configuration panels.
                // Existing providers retain their bespoke setup UX;
                // new registry providers get a generic fallback panel.
                providerConfigPanel
            }
        }
    }

    /// Routes to bespoke setup panels for known providers, or a generic
    /// fallback for providers added to the registry without custom UI.
    @ViewBuilder
    private var providerConfigPanel: some View {
        switch ttsProviderRaw {
        case "elevenlabs":
            elevenLabsProviderConfig
        case "fish-audio":
            fishAudioProviderConfig
        default:
            if let provider = selectedProvider {
                genericProviderConfig(for: provider)
            }
        }
    }

    private func providerOption(label: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: VSpacing.sm) {
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

    // MARK: - ElevenLabs Provider Config

    private var elevenLabsProviderConfig: some View {
        Group {
            if elevenLabsHasKey {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .primary) {}
                    VButton(label: "Disconnect", style: .danger) {
                        store.clearElevenLabsKey()
                        elevenLabsHasKey = false
                        elevenLabsKeyText = ""
                        ttsSetupExpanded = false
                    }
                }
            } else if ttsSetupExpanded {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    VTextField(
                        "ElevenLabs API Key",
                        placeholder: "Your ElevenLabs API key",
                        text: $elevenLabsKeyText,
                        isSecure: true,
                        maxWidth: 400
                    )

                    HStack(spacing: VSpacing.xs) {
                        VIconView(.lock, size: 10)
                            .foregroundStyle(VColor.contentTertiary)
                        Text("Your API key is stored securely in the macOS Keychain.")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }

                    HStack(spacing: VSpacing.sm) {
                        VButton(label: "Connect", style: .outlined, isDisabled: elevenLabsKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                            store.saveElevenLabsKey(elevenLabsKeyText)
                            elevenLabsHasKey = true
                            elevenLabsKeyText = ""
                            ttsSetupExpanded = false
                        }
                        VButton(label: "Cancel", style: .outlined) {
                            ttsSetupExpanded = false
                            elevenLabsKeyText = ""
                        }
                    }
                }
            } else {
                VButton(label: "Set Up", style: .outlined) {
                    ttsSetupExpanded = true
                }
            }
        }
    }

    // MARK: - Fish Audio Provider Config

    private var fishAudioProviderConfig: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("1. Create a Fish Audio account at fish.audio")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                Text("2. Generate an API key from your Fish Audio dashboard")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                Text("3. Choose or create a voice and copy its reference ID")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                Text("4. Run the setup commands in your terminal:")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }

            Text("assistant credentials set --service fish-audio --field api_key YOUR_KEY\nassistant config set services.tts.providers.fish-audio.referenceId YOUR_VOICE_ID")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(VColor.contentSecondary)
                .padding(VSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(VColor.surfaceBase)
                )
                .textSelection(.enabled)

            VButton(label: "Visit Fish Audio", rightIcon: VIcon.arrowUpRight.rawValue, style: .outlined) {
                NSWorkspace.shared.open(URL(string: "https://fish.audio")!)
            }
        }
    }

    // MARK: - Generic Provider Config (Fallback)

    /// Generic setup panel for providers added to the registry that do not
    /// have bespoke UI. Shows the setup hint from the catalog metadata and
    /// renders either an inline API key field or CLI instructions depending
    /// on the provider's `setupMode`.
    private func genericProviderConfig(for entry: TTSProviderCatalogEntry) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text(entry.setupHint)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)

            switch entry.setupMode {
            case .apiKey:
                Text("Configure this provider via the CLI:")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)

                Text("assistant keys set \(entry.id) YOUR_KEY")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(VColor.contentSecondary)
                    .padding(VSpacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(VColor.surfaceBase)
                    )
                    .textSelection(.enabled)

            case .cli:
                Text("Follow your provider's documentation to complete setup via the CLI.")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }
}
