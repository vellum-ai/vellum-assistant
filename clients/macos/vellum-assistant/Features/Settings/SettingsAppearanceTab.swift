import SwiftUI
import VellumAssistantShared

/// Appearance settings tab — theme selection, keyboard shortcuts, and media embed configuration.
struct SettingsAppearanceTab: View {
    @ObservedObject var store: SettingsStore
    @AppStorage("themePreference") private var themePreference: String = "system"
    @State private var newAllowlistDomain = ""
    @State private var isRecordingGlobalHotkey = false
    @State private var shortcutMonitor: Any?
    @State private var shortcutConflictWarning: String?

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

            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)

            // KEYBOARD SHORTCUTS section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Keyboard Shortcuts")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                // Open Vellum (configurable)
                HStack {
                    Text("Open Vellum")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    Text(ShortcutHelper.displayString(for: store.globalHotkeyShortcut))
                        .font(VFont.mono)
                        .foregroundColor(VColor.textPrimary)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(VColor.surface)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.sm)
                                .stroke(VColor.surfaceBorder, lineWidth: 1)
                        )

                    if isRecordingGlobalHotkey {
                        VButton(label: "Press shortcut...", style: .tertiary) {
                            stopRecording()
                        }
                    } else {
                        VButton(label: "Record", style: .tertiary) {
                            startRecording()
                        }
                    }
                }

                if let shortcutConflictWarning {
                    Text(shortcutConflictWarning)
                        .font(VFont.caption)
                        .foregroundColor(VColor.warning)
                }
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
                    Toggle("", isOn: Binding(
                        get: { store.mediaEmbedsEnabled },
                        set: { store.setMediaEmbedsEnabled($0) }
                    ))
                    .toggleStyle(.switch)
                    .labelsHidden()
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

                        VButton(label: "Add", style: .primary) {
                            let domain = newAllowlistDomain
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !domain.isEmpty else { return }
                            var domains = store.mediaEmbedVideoAllowlistDomains
                            domains.append(domain)
                            store.setMediaEmbedVideoAllowlistDomains(domains)
                            newAllowlistDomain = ""
                        }
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
        isRecordingGlobalHotkey = true
        shortcutConflictWarning = nil

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
            store.globalHotkeyShortcut = shortcut
            stopRecording()
            return nil
        }
    }

    private func stopRecording() {
        isRecordingGlobalHotkey = false
        if let monitor = shortcutMonitor {
            NSEvent.removeMonitor(monitor)
            shortcutMonitor = nil
        }
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
