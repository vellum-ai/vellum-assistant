import SwiftUI
import VellumAssistantShared

/// Voice settings tab — configure push-to-talk activation key,
/// conversation timeout, and text-to-speech.
struct VoiceSettingsView: View {
    @ObservedObject var store: SettingsStore

    @AppStorage("activationKey") private var activationKey: String = "fn"
    @AppStorage("voiceConversationTimeoutSeconds") private var conversationTimeoutSeconds: Int = 30

    @State private var elevenLabsKeyText: String = ""
    @State private var ttsSetupExpanded: Bool = false
    @State private var isRecordingCustomKey: Bool = false
    @State private var recordingMonitors: [Any] = []
    @State private var modifierHoldTimer: Timer? = nil

    private var currentActivator: PTTActivator {
        // Read activationKey to establish SwiftUI dependency tracking —
        // without this, SwiftUI doesn't know the body depends on this
        // @AppStorage value and skips re-rendering when it changes.
        _ = activationKey
        return PTTActivator.fromStored()
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
            ttsCard
            readAloudCard
        }
        .onDisappear {
            stopRecordingCustomKey()
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
                        .foregroundColor(VColor.contentSecondary)

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
                                .foregroundColor(VColor.contentTertiary)
                            Text("This key will still type in other apps while held. For seamless use, a dedicated key (F-key, mouse button) is recommended.")
                                .font(VFont.labelDefault)
                                .foregroundColor(VColor.contentTertiary)
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
                    .foregroundColor(VColor.contentDefault)
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

    // MARK: - Voice Conversation TTS Card

    private var ttsCard: some View {
        SettingsCard(title: "Text-to-Speech", subtitle: "ElevenLabs provides high-quality voice responses during voice conversations. An API key is required.") {
            if store.hasElevenLabsKey {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .primary) {}
                    VButton(label: "Disconnect", style: .danger) {
                        store.clearElevenLabsKey()
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
                            .foregroundColor(VColor.contentTertiary)
                        Text("Your API key is stored securely in the macOS Keychain.")
                            .font(VFont.labelDefault)
                            .foregroundColor(VColor.contentTertiary)
                    }

                    HStack(spacing: VSpacing.sm) {
                        VButton(label: "Connect", style: .outlined, isDisabled: elevenLabsKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                            store.saveElevenLabsKey(elevenLabsKeyText)
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

    // MARK: - Read Aloud Card

    private var readAloudCard: some View {
        SettingsCard(title: "Read Aloud", subtitle: "Fish Audio powers natural-sounding read-aloud for any assistant message. Requires a Fish Audio account with an API key and a voice reference ID.") {
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

                Text("assistant credentials set --service fish-audio --field api_key YOUR_KEY\nassistant config set fishAudio.referenceId YOUR_VOICE_ID")
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
    }
}
