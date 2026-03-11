import SwiftUI
import VellumAssistantShared

/// Appearance settings tab — theme selection, keyboard shortcuts, and media embed configuration.
struct SettingsAppearanceTab: View {
    private static let knownTimezones: [String] = TimeZone.knownTimeZoneIdentifiers.sorted()

    @ObservedObject var store: SettingsStore
    @AppStorage("themePreference") private var themePreference: String = "system"
    @State private var newAllowlistDomain = ""
    @State private var isRecordingGlobalHotkey = false
    @State private var isRecordingQuickInputHotkey = false
    @State private var shortcutMonitor: Any?
    @State private var flagsMonitor: Any?
    @State private var recordingDisplayString: String?
    @State private var shortcutConflictWarning: String?
    @State private var selectedTimezone: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // DISPLAY section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Display")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                HStack(alignment: .center, spacing: VSpacing.lg) {
                    Text("Theme")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    VSegmentedControl(
                        items: [
                            (label: "System", tag: "system"),
                            (label: "Light", tag: "light"),
                            (label: "Dark", tag: "dark"),
                        ],
                        selection: Binding(
                            get: { themePreference },
                            set: { newValue in
                                themePreference = newValue
                                AppDelegate.shared?.applyThemePreference()
                            }
                        ),
                        style: .pill
                    )
                    .fixedSize()
                }

                Divider().background(VColor.surfaceBorder)

                HStack(alignment: .top, spacing: VSpacing.lg) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("User timezone")
                            .font(VFont.inputLabel)
                            .foregroundColor(VColor.textSecondary)
                        Text("Timezone used for time-aware responses.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    Spacer()
                    VDropdown(
                        placeholder: "Not Set",
                        selection: $selectedTimezone,
                        options: [(label: "Not Set", value: "")] + Self.knownTimezones.map { (label: $0, value: $0) },
                        emptyValue: ""
                    )
                    .frame(width: 200)
                }
                .onChange(of: selectedTimezone) { oldValue, newValue in
                    guard oldValue != newValue else { return }
                    if newValue.isEmpty {
                        store.clearUserTimezone()
                    } else {
                        store.saveUserTimezone(newValue)
                    }
                }

            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .vCard(background: VColor.surfaceSubtle)
            .onAppear {
                selectedTimezone = store.userTimezone ?? ""
            }
            .onChange(of: store.userTimezone) { _, newStoreValue in
                let mapped = newStoreValue ?? ""
                if mapped != selectedTimezone {
                    selectedTimezone = mapped
                }
            }

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
                        VButton(label: "Press shortcut...", style: .outlined, size: .medium) {
                            stopRecording()
                        }
                    } else {
                        HStack(spacing: VSpacing.sm) {
                            VButton(label: "Record", style: .outlined, size: .medium) {
                                startRecording()
                            }
                            if !store.globalHotkeyShortcut.isEmpty {
                                VButton(label: "Unbind", style: .outlined, size: .medium) {
                                    store.globalHotkeyShortcut = ""
                                }
                            }
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
                        VButton(label: "Press shortcut...", style: .outlined, size: .medium) {
                            stopRecording()
                        }
                    } else {
                        HStack(spacing: VSpacing.sm) {
                            VButton(label: "Record", style: .outlined, size: .medium) {
                                startRecordingQuickInput()
                            }
                            if !store.quickInputHotkeyShortcut.isEmpty {
                                VButton(label: "Unbind", style: .outlined, size: .medium) {
                                    store.quickInputHotkeyShortcut = ""
                                    store.quickInputHotkeyKeyCode = 0
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, VSpacing.md)

                Divider().background(VColor.surfaceBorder)

                ShortcutRow(label: "Start voice input", shortcut: PTTActivator.fromStored().kind != .none ? "Hold \(PTTActivator.fromStored().displayName)" : "Disabled")

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
            .frame(maxWidth: .infinity, alignment: .leading)
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

                    HStack(spacing: VSpacing.sm) {
                        TextField("Add domain (e.g. example.com)", text: $newAllowlistDomain)
                            .vInputStyle()
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                            .onSubmit {
                                addAllowlistDomain()
                            }

                        VButton(label: "Add", style: .primary, size: .medium, isDisabled: newAllowlistDomain.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                            addAllowlistDomain()
                        }
                    }

                    ForEach(store.mediaEmbedVideoAllowlistDomains, id: \.self) { domain in
                        HStack {
                            Text(domain)
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                                .textSelection(.enabled)
                            Spacer()
                            VIconButton(label: "Remove domain", icon: VIcon.trash.rawValue, iconOnly: true, variant: .danger) {
                                var domains = store.mediaEmbedVideoAllowlistDomains
                                domains.removeAll { $0 == domain }
                                store.setMediaEmbedVideoAllowlistDomains(domains)
                            }
                        }
                        .padding(.vertical, VSpacing.xs)
                    }

                    VButton(label: "Reset to Defaults", style: .secondary, size: .medium) {
                        store.setMediaEmbedVideoAllowlistDomains(MediaEmbedSettings.defaultDomains)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .vCard(background: VColor.surfaceSubtle)
        }
    }

    // MARK: - Allowlist

    private func addAllowlistDomain() {
        let domain = newAllowlistDomain.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !domain.isEmpty else { return }
        var domains = store.mediaEmbedVideoAllowlistDomains
        domains.append(domain)
        store.setMediaEmbedVideoAllowlistDomains(domains)
        newAllowlistDomain = ""
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
