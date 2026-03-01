import SwiftUI
import VellumAssistantShared

/// Appearance settings tab — theme selection, keyboard shortcuts, and media embed configuration.
struct SettingsAppearanceTab: View {
    @ObservedObject var store: SettingsStore
    @AppStorage("themePreference") private var themePreference: String = "system"
    @State private var newAllowlistDomain = ""
    @State private var isRecordingGlobalHotkey = false
    @State private var isRecordingQuickInputHotkey = false
    @State private var shortcutMonitor: Any?
    @State private var flagsMonitor: Any?
    @State private var recordingDisplayString: String?
    @State private var shortcutConflictWarning: String?
    @State private var showTimezonePicker = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            // DISPLAY section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Display")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                HStack {
                    Text("Theme")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    Picker("", selection: Binding(
                        get: { themePreference },
                        set: { newValue in
                            themePreference = newValue
                            AppDelegate.shared?.applyThemePreference()
                        }
                    )) {
                        Text("System").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 200)
                }

                Divider()
                    .background(VColor.surfaceBorder)

                HStack(alignment: .center, spacing: VSpacing.sm) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("User timezone")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Text("Timezone used for time-aware responses.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    Spacer()
                    if let tz = store.userTimezone {
                        Text(tz)
                            .font(VFont.mono)
                            .foregroundColor(VColor.textPrimary)
                    } else {
                        Text("Not set")
                            .font(VFont.body)
                            .foregroundColor(VColor.textMuted)
                    }
                    VButton(label: store.userTimezone != nil ? "Change" : "Set", style: .tertiary) {
                        showTimezonePicker = true
                    }
                    .popover(isPresented: $showTimezonePicker, arrowEdge: .bottom) {
                        TimezonePicker { selected in
                            store.saveUserTimezone(selected)
                            showTimezonePicker = false
                        }
                    }
                    if store.userTimezone != nil {
                        VButton(label: "Clear", style: .tertiary) {
                            store.clearUserTimezone()
                        }
                    }
                }

            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)

            // KEYBOARD SHORTCUTS section
            VStack(alignment: .leading, spacing: 0) {
                Text("Keyboard Shortcuts")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                    .padding(.bottom, VSpacing.md)

                // Open Vellum (configurable)
                HStack {
                    Text("Open Vellum")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    if isRecordingGlobalHotkey, let display = recordingDisplayString, !display.isEmpty {
                        shortcutKeyPill(display)
                    } else {
                        shortcutKeyPill(ShortcutHelper.displayString(for: store.globalHotkeyShortcut))
                    }

                    if isRecordingGlobalHotkey {
                        VButton(label: "Press shortcut...", style: .outlined, size: .large) {
                            stopRecording()
                        }
                    } else {
                        VButton(label: "Record", style: .outlined, size: .large) {
                            startRecording()
                        }
                    }
                }
                .padding(.vertical, VSpacing.md)

                if let shortcutConflictWarning {
                    Text(shortcutConflictWarning)
                        .font(VFont.caption)
                        .foregroundColor(VColor.warning)
                        .padding(.bottom, VSpacing.xs)
                }

                Divider().background(VColor.surfaceBorder)

                // Quick Input (configurable)
                HStack {
                    Text("Quick Input")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    if isRecordingQuickInputHotkey, let display = recordingDisplayString, !display.isEmpty {
                        shortcutKeyPill(display)
                    } else {
                        shortcutKeyPill(ShortcutHelper.displayString(for: store.quickInputHotkeyShortcut))
                    }

                    if isRecordingQuickInputHotkey {
                        VButton(label: "Press shortcut...", style: .outlined, size: .large) {
                            stopRecording()
                        }
                    } else {
                        VButton(label: "Record", style: .outlined, size: .large) {
                            startRecordingQuickInput()
                        }
                    }
                }
                .padding(.vertical, VSpacing.md)

                Divider().background(VColor.surfaceBorder)

                ShortcutRow(label: "Start voice input", shortcut: "Hold Fn")

                Divider().background(VColor.surfaceBorder)

                HStack(alignment: .center, spacing: VSpacing.sm) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Send with ⌘Enter")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Text("When enabled, Enter inserts a new line and ⌘Enter sends.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    Spacer()
                    VToggle(isOn: Binding(
                        get: { store.cmdEnterToSend },
                        set: { store.cmdEnterToSend = $0 }
                    ))
                }
                .padding(.vertical, VSpacing.md)
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)
            .onDisappear {
                stopRecording()
            }

            // MEDIA EMBEDS section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Media Embeds")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                HStack {
                    Text("Auto media embeds")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    VToggle(isOn: Binding(
                        get: { store.mediaEmbedsEnabled },
                        set: { store.setMediaEmbedsEnabled($0) }
                    ))
                }

                Text("Automatically embed images, videos, and other media shared in chat messages.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .textSelection(.enabled)

                if store.mediaEmbedsEnabled {
                    Divider()
                        .background(VColor.surfaceBorder)

                    Text("Video Domain Allowlist")
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.textSecondary)

                    VInlineActionField(text: $newAllowlistDomain, placeholder: "Add domain (e.g. example.com)", actionLabel: "Add") {
                        let domain = newAllowlistDomain
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !domain.isEmpty else { return }
                        var domains = store.mediaEmbedVideoAllowlistDomains
                        domains.append(domain)
                        store.setMediaEmbedVideoAllowlistDomains(domains)
                        newAllowlistDomain = ""
                    }

                    ForEach(store.mediaEmbedVideoAllowlistDomains, id: \.self) { domain in
                        HStack {
                            Text(domain)
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                                .textSelection(.enabled)
                            Spacer()
                            Button {
                                var domains = store.mediaEmbedVideoAllowlistDomains
                                domains.removeAll { $0 == domain }
                                store.setMediaEmbedVideoAllowlistDomains(domains)
                            } label: {
                                Image(systemName: "trash")
                                    .foregroundColor(VColor.error)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.vertical, VSpacing.xs)
                    }

                    HStack {
                        Spacer()
                        VButton(label: "Reset to Defaults", style: .tertiary) {
                            store.setMediaEmbedVideoAllowlistDomains(MediaEmbedSettings.defaultDomains)
                        }
                    }
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)
        }
    }

    // MARK: - Shortcut Recording

    private func startRecording() {
        startRecordingShortcut { shortcut, _ in
            store.globalHotkeyShortcut = shortcut
        }
        isRecordingGlobalHotkey = true
    }

    private func startRecordingQuickInput() {
        startRecordingShortcut { shortcut, keyCode in
            store.quickInputHotkeyShortcut = shortcut
            store.quickInputHotkeyKeyCode = Int(keyCode)
        }
        isRecordingQuickInputHotkey = true
    }

    /// Shared recording logic. The callback receives the shortcut string and the raw NSEvent key code.
    private func startRecordingShortcut(onRecord: @escaping (String, UInt16) -> Void) {
        stopRecording()
        shortcutConflictWarning = nil
        recordingDisplayString = nil

        // Monitor modifier key changes to show pressed modifiers in real-time.
        flagsMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { event in
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            recordingDisplayString = ShortcutHelper.modifierDisplayString(from: mods)
            return event
        }

        shortcutMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)

            if event.keyCode == 53 {
                stopRecording()
                return nil
            }

            let hasModifier = mods.contains(.command) || mods.contains(.control)
                || mods.contains(.option)
            guard hasModifier,
                  let chars = event.charactersIgnoringModifiers, !chars.isEmpty else {
                return nil
            }

            let shortcut = ShortcutHelper.shortcutString(
                from: mods, key: chars, keyCode: event.keyCode
            )

            shortcutConflictWarning = nil
            onRecord(shortcut, event.keyCode)
            stopRecording()
            return nil
        }
    }

    private func stopRecording() {
        isRecordingGlobalHotkey = false
        isRecordingQuickInputHotkey = false
        recordingDisplayString = nil
        if let monitor = shortcutMonitor {
            NSEvent.removeMonitor(monitor)
            shortcutMonitor = nil
        }
        if let monitor = flagsMonitor {
            NSEvent.removeMonitor(monitor)
            flagsMonitor = nil
        }
    }

    // MARK: - Pill helper

    @ViewBuilder
    private func shortcutKeyPill(_ text: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            ForEach(text.components(separatedBy: " "), id: \.self) { token in
                Text(token)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.xs)
        .background(VColor.surfaceSubtle)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
    }
}

/// A read-only row displaying a keyboard shortcut and its description.
private struct ShortcutRow: View {
    let label: String
    let shortcut: String

    var body: some View {
        HStack {
            Text(label)
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
            Spacer()
            HStack(spacing: VSpacing.sm) {
                ForEach(shortcut.components(separatedBy: " "), id: \.self) { token in
                    Text(token)
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.xs)
            .background(VColor.surfaceSubtle)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.xl)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
        }
        .padding(.vertical, VSpacing.md)
    }
}

#Preview("Appearance Tab") {
    ZStack {
        VColor.background.ignoresSafeArea()
        SettingsAppearanceTab(store: SettingsStore())
            .padding()
    }
    .frame(width: 500, height: 600)
}
