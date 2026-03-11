import SwiftUI
import VellumAssistantShared

/// Voice settings tab — configure push-to-talk activation key,
/// enable/disable wake word listening, configure keyword phrase,
/// and conversation timeout.
struct VoiceSettingsView: View {
    @ObservedObject var store: SettingsStore

    @AppStorage("activationKey") private var activationKey: String = "fn"
    @AppStorage("wakeWordEnabled") private var wakeWordEnabled: Bool = false
    @AppStorage("wakeWordTimeoutSeconds") private var wakeWordTimeoutSeconds: Int = 30
    @AppStorage("wakeWordKeyword") private var wakeWordKeyword: String = "computer"

    @State private var elevenLabsKeyText: String = ""
    @State private var ttsSetupExpanded: Bool = false
    @State private var isRecordingCustomKey: Bool = false
    @State private var recordingMonitors: [Any] = []
    @State private var modifierHoldTimer: Timer? = nil

    private let suggestedKeywords = ["computer", "jarvis", "hey vellum", "assistant"]

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
            wakeWordCard
            ttsCard
        }
        .onDisappear {
            stopRecordingCustomKey()
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
                    Text("Activation key")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.textSecondary)

                    HStack(spacing: VSpacing.sm) {
                        // Preset buttons
                        ForEach(Array(presets.enumerated()), id: \.offset) { _, preset in
                            let isSelected = currentActivator == preset.activator
                            Button(preset.label) {
                                selectActivator(preset.activator)
                            }
                            .buttonStyle(.plain)
                            .font(VFont.caption)
                            .foregroundColor(isSelected ? .white : VColor.textMuted)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xs)
                            .contentShape(Capsule())
                            .background(
                                Capsule()
                                    .fill(isSelected ? Forest._700 : VColor.surface)
                            )
                            .overlay(
                                Capsule()
                                    .strokeBorder(isSelected ? Color.clear : VColor.surfaceBorder, lineWidth: 1)
                            )
                        }

                        // Custom button / recording state
                        if isRecordingCustomKey {
                            Button("Press any key...") {
                                stopRecordingCustomKey()
                            }
                            .buttonStyle(.plain)
                            .font(VFont.caption)
                            .foregroundColor(.white)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xs)
                            .contentShape(Capsule())
                            .background(
                                Capsule()
                                    .fill(VColor.accent)
                            )
                        } else {
                            let isCustom = !presets.contains(where: { $0.activator == currentActivator })
                            Button(isCustom ? currentActivator.displayName : "Custom...") {
                                startRecordingCustomKey()
                            }
                            .buttonStyle(.plain)
                            .font(VFont.caption)
                            .foregroundColor(isCustom ? .white : VColor.textMuted)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xs)
                            .contentShape(Capsule())
                            .background(
                                Capsule()
                                    .fill(isCustom ? Forest._700 : VColor.surface)
                            )
                            .overlay(
                                Capsule()
                                    .strokeBorder(isCustom ? Color.clear : VColor.surfaceBorder, lineWidth: 1)
                            )
                        }
                    }

                    // Show info note when a regular key (not modifier-only, not off) is selected
                    if currentActivator.kind == .key {
                        HStack(alignment: .top, spacing: VSpacing.xs) {
                            VIconView(.info, size: 10)
                                .foregroundColor(VColor.textMuted)
                            Text("This key will still type in other apps while held. For seamless use, a dedicated key (F-key, mouse button) is recommended.")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                                .lineSpacing(1)
                        }
                    }
                }
            }
        }
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

    // MARK: - Wake Word Card

    private var wakeWordCard: some View {
        SettingsCard(title: "Talk to Vellum, hands free", subtitle: "Wake word lets you start a conversation by speaking a keyword aloud \u{2014} no need to click or press anything. It uses on-device speech recognition, so nothing you say ever leaves your Mac.") {
            VToggle(
                isOn: $wakeWordEnabled,
                label: "Enable Wake Word Listening",
                helperText: "Activate the assistant by speaking instead of using a keyboard shortcut."
            )

            if wakeWordEnabled {
                // How it works steps
                HStack(alignment: .top, spacing: VSpacing.md) {
                    wakeWordStepCard(number: "1", title: "Say the keyword", description: "Speak your wake word when you\u{2019}re ready to talk.")
                    wakeWordStepCard(number: "2", title: "Vellum starts listening", description: "A chime plays and your microphone activates.")
                    wakeWordStepCard(number: "3", title: "Ask anything", description: "Speak naturally. Vellum responds when you pause.")
                }

                // Keyword
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Keyword")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.textSecondary)

                    TextField("Enter wake word or phrase", text: $wakeWordKeyword)
                        .vInputStyle()
                        .accessibilityLabel("Wake word keyword")

                    HStack(spacing: VSpacing.sm) {
                        ForEach(suggestedKeywords, id: \.self) { suggestion in
                            Button(suggestion) {
                                wakeWordKeyword = suggestion
                            }
                            .buttonStyle(.plain)
                            .font(VFont.caption)
                            .foregroundColor(wakeWordKeyword == suggestion ? .white : VColor.textMuted)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xs)
                            .background(Capsule().fill(wakeWordKeyword == suggestion ? Forest._700 : VColor.surface))
                            .overlay(Capsule().strokeBorder(wakeWordKeyword == suggestion ? Color.clear : VColor.surfaceBorder, lineWidth: 1))
                        }
                    }
                }

                // Conversation timeout
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Conversation timeout")
                            .font(VFont.inputLabel)
                            .foregroundColor(VColor.textSecondary)
                        Text("How long to wait for follow-up speech before ending the conversation.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    VDropdown(
                        placeholder: "Select timeout\u{2026}",
                        selection: $wakeWordTimeoutSeconds,
                        options: timeoutOptions
                    )
                    .frame(width: 160)
                    .accessibilityLabel("Conversation timeout duration")
                }

                // Privacy note
                HStack(spacing: VSpacing.xs) {
                    VIconView(.lock, size: 10)
                        .foregroundColor(VColor.textMuted)
                    Text("Uses on-device speech recognition \u{2014} no data leaves your Mac.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
        }
    }

    private func wakeWordStepCard(number: String, title: String, description: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text(number)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(VColor.success)
                .frame(width: 24, height: 24)
                .background(Circle().fill(VColor.success.opacity(0.15)))

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(title)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                Text(description)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .lineSpacing(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private let timeoutOptions: [(label: String, value: Int)] = [
        (label: "5 seconds", value: 5),
        (label: "10 seconds", value: 10),
        (label: "15 seconds", value: 15),
        (label: "30 seconds", value: 30),
        (label: "60 seconds", value: 60),
    ]

    // MARK: - Text-to-Speech Card

    private var ttsCard: some View {
        SettingsCard(title: "Text-to-Speech", subtitle: "ElevenLabs provides high-quality voice responses during voice conversations. An API key is required.") {
            if store.hasElevenLabsKey {
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .success, size: .medium) {}
                    VButton(label: "Disconnect", style: .danger, size: .medium) {
                        store.clearElevenLabsKey()
                        elevenLabsKeyText = ""
                        ttsSetupExpanded = false
                    }
                }
            } else if ttsSetupExpanded {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("ElevenLabs API Key")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.textSecondary)

                    SecureField("Your ElevenLabs API key", text: $elevenLabsKeyText)
                        .vInputStyle()
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)

                    HStack(spacing: VSpacing.xs) {
                        VIconView(.lock, size: 10)
                            .foregroundColor(VColor.textMuted)
                        Text("Your API key is stored securely in the macOS Keychain.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }

                    HStack(spacing: VSpacing.sm) {
                        VButton(label: "Connect", style: .secondary, size: .medium, isDisabled: elevenLabsKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                            store.saveElevenLabsKey(elevenLabsKeyText)
                            elevenLabsKeyText = ""
                            ttsSetupExpanded = false
                        }
                        VButton(label: "Cancel", style: .tertiary, size: .medium) {
                            ttsSetupExpanded = false
                            elevenLabsKeyText = ""
                        }
                    }
                }
            } else {
                VButton(label: "Set Up", style: .secondary, size: .medium) {
                    ttsSetupExpanded = true
                }
            }
        }
    }
}
