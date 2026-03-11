import SwiftUI
import VellumAssistantShared

/// Appearance settings tab — theme selection, keyboard shortcuts, and media embed configuration.
struct SettingsAppearanceTab: View {
    private static let knownTimezones: [String] = TimeZone.knownTimeZoneIdentifiers.sorted()

    @ObservedObject var store: SettingsStore
    var afterTimezone: AnyView? = nil
    @AppStorage("themePreference") private var themePreference: String = "system"
    @State private var newAllowlistDomain = ""
    @State private var isRecordingGlobalHotkey = false
    @State private var isRecordingQuickInputHotkey = false
    @State private var shortcutMonitor: Any?
    @State private var flagsMonitor: Any?
    @State private var recordingDisplayString: String?
    @State private var shortcutConflictWarning: String?
    @State private var selectedTimezone: String = ""
    @State private var timezoneSearchText: String = ""
    @State private var isTimezoneDropdownOpen: Bool = false
    @FocusState private var isTimezoneSearchFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // THEME section
            SettingsCard(title: "Theme") {
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

            // TIMEZONE section
            SettingsCard(title: "Timezone") {
                // Searchable timezone picker
                VStack(spacing: 0) {
                    HStack {
                        Text("Closest city")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        HStack(spacing: VSpacing.md) {
                            VIconView(.search, size: 13)
                                .foregroundColor(VColor.textMuted)
                            TextField(selectedCityPlaceholder, text: $timezoneSearchText)
                                .font(VFont.body)
                                .foregroundColor(VColor.textPrimary)
                                .textFieldStyle(.plain)
                                .focused($isTimezoneSearchFocused)
                            if !timezoneSearchText.isEmpty {
                                Button {
                                    timezoneSearchText = ""
                                    isTimezoneDropdownOpen = false
                                } label: {
                                    VIconView(.x, size: 11)
                                        .foregroundColor(VColor.textMuted)
                                }
                                .buttonStyle(.plain)
                                .pointerCursor()
                            }
                        }
                        .padding(.horizontal, VSpacing.md)
                        .frame(width: 280, height: 28)
                        .background(VColor.inputBackground)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                        )
                    }
                    .onChange(of: timezoneSearchText) { _, newValue in
                        isTimezoneDropdownOpen = !newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    }
                    .onChange(of: isTimezoneSearchFocused) { _, focused in
                        if focused && timezoneSearchText.isEmpty {
                            // Show all when focused with empty search
                            isTimezoneDropdownOpen = true
                        }
                    }

                    if isTimezoneDropdownOpen {
                        let filtered = filteredTimezones
                        if !filtered.isEmpty {
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 0) {
                                    ForEach(filtered, id: \.identifier) { entry in
                                        Button {
                                            selectedTimezone = entry.identifier
                                            timezoneSearchText = ""
                                            isTimezoneDropdownOpen = false
                                            isTimezoneSearchFocused = false
                                        } label: {
                                            HStack {
                                                Text(entry.displayLabel)
                                                    .font(VFont.body)
                                                    .foregroundColor(VColor.textPrimary)
                                                Spacer()
                                                Text(entry.currentTime)
                                                    .font(VFont.caption)
                                                    .foregroundColor(VColor.textMuted)
                                            }
                                            .padding(.horizontal, VSpacing.md)
                                            .padding(.vertical, VSpacing.sm)
                                            .background(
                                                entry.identifier == selectedTimezone
                                                    ? VColor.navActive
                                                    : Color.clear
                                            )
                                            .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain)
                                        .pointerCursor()
                                    }
                                }
                            }
                            .frame(maxHeight: 200)
                            .background {
                                OverlayScrollerStyle()
                            }
                            .background(VColor.inputBackground)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.lg)
                                    .strokeBorder(VColor.cardBorder, lineWidth: 2)
                            )
                            .padding(.top, VSpacing.xs)
                        }
                    }
                }
                .onChange(of: selectedTimezone) { oldValue, newValue in
                    guard oldValue != newValue else { return }
                    if newValue.isEmpty {
                        store.clearUserTimezone()
                    } else {
                        store.saveUserTimezone(newValue)
                    }
                }

                SettingsDivider()

                HStack {
                    Text("Time zone")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    Text(timezoneDisplayName)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                }
            }
            .onAppear {
                selectedTimezone = store.userTimezone ?? ""
            }
            .onChange(of: store.userTimezone) { _, newStoreValue in
                let mapped = newStoreValue ?? ""
                if mapped != selectedTimezone {
                    selectedTimezone = mapped
                }
            }

            if let afterTimezone { afterTimezone }

            // KEYBOARD SHORTCUTS section
            SettingsCard(title: "Keyboard Shortcuts") {
                VStack(alignment: .leading, spacing: 0) {

                // Open Vellum (configurable)
                HStack {
                    Text("Open Vellum")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    if isRecordingGlobalHotkey, let display = recordingDisplayString, !display.isEmpty {
                        VShortcutTag(display)
                    } else {
                        VShortcutTag(ShortcutHelper.displayString(for: store.globalHotkeyShortcut))
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

                SettingsDivider()

                // Quick Input (configurable)
                HStack {
                    Text("Quick Input")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    if isRecordingQuickInputHotkey, let display = recordingDisplayString, !display.isEmpty {
                        VShortcutTag(display)
                    } else {
                        VShortcutTag(ShortcutHelper.displayString(for: store.quickInputHotkeyShortcut))
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

                SettingsDivider()

                ShortcutRow(label: "Start voice input", shortcut: PTTActivator.fromStored().kind != .none ? "Hold \(PTTActivator.fromStored().displayName)" : "Disabled")

                SettingsDivider()

                VToggle(
                    isOn: Binding(
                        get: { store.cmdEnterToSend },
                        set: { store.cmdEnterToSend = $0 }
                    ),
                    label: "Send with Cmd+Enter",
                    helperText: "When enabled, Enter inserts a new line and cmd+enter sends."
                )
                .padding(.vertical, VSpacing.md)
                }
            }
            .onDisappear {
                stopRecording()
            }

            // MEDIA EMBEDS section
            SettingsCard(title: "Media Embeds", subtitle: "Automatically embed images, videos, and other media shared in chat messages.") {
                VToggle(
                    isOn: Binding(
                        get: { store.mediaEmbedsEnabled },
                        set: { store.setMediaEmbedsEnabled($0) }
                    ),
                    label: "Auto Media Embeds"
                )

                if store.mediaEmbedsEnabled {
                    SettingsDivider()

                    Text("Video Domain Allowlist")
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.textPrimary)

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Add Domain")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)

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
                    }

                    ForEach(store.mediaEmbedVideoAllowlistDomains, id: \.self) { domain in
                        HStack {
                            Text(domain)
                                .font(VFont.body)
                                .foregroundColor(VColor.textPrimary)
                                .textSelection(.enabled)
                            Spacer()
                            VIconButton(label: "Remove domain", icon: VIcon.trash.rawValue, iconOnly: true, variant: .danger) {
                                var domains = store.mediaEmbedVideoAllowlistDomains
                                domains.removeAll { $0 == domain }
                                store.setMediaEmbedVideoAllowlistDomains(domains)
                            }
                        }
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.sm)
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.lg)
                                .strokeBorder(VColor.cardBorder, lineWidth: 1)
                        )
                    }
                }
            }
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

    // MARK: - Timezone Helpers

    private struct TimezoneEntry {
        let identifier: String
        let city: String
        let region: String
        let displayLabel: String
        let currentTime: String
        let utcOffset: String
    }

    /// Stable timezone metadata (city, region, offset label) — computed once.
    private struct TimezoneMetadata {
        let identifier: String
        let city: String
        let region: String
        let utcOffset: String
        let tz: TimeZone
    }

    private var selectedCityPlaceholder: String {
        guard !selectedTimezone.isEmpty,
              let tz = TimeZone(identifier: selectedTimezone) else {
            return "Search city or country..."
        }
        let parts = selectedTimezone.components(separatedBy: "/")
        let city = (parts.last ?? selectedTimezone).replacingOccurrences(of: "_", with: " ")
        return city
    }

    private var timezoneDisplayName: String {
        guard !selectedTimezone.isEmpty else { return "Not Set" }
        let tz = TimeZone(identifier: selectedTimezone) ?? .current
        return tz.localizedName(for: .standard, locale: .current) ?? selectedTimezone
    }

    /// Stable metadata cached once; time-sensitive fields computed on access.
    private static let timezoneMetadata: [TimezoneMetadata] = {
        knownTimezones.compactMap { id -> TimezoneMetadata? in
            guard let tz = TimeZone(identifier: id) else { return nil }
            let parts = id.components(separatedBy: "/")
            let city = (parts.last ?? id).replacingOccurrences(of: "_", with: " ")
            let region = parts.count > 1 ? parts[0].replacingOccurrences(of: "_", with: " ") : ""

            let seconds = tz.secondsFromGMT()
            let hours = seconds / 3600
            let minutes = abs(seconds % 3600) / 60
            let offsetStr = minutes > 0
                ? String(format: "GMT%+d:%02d", hours, minutes)
                : String(format: "GMT%+d", hours)

            return TimezoneMetadata(identifier: id, city: city, region: region, utcOffset: offsetStr, tz: tz)
        }
        .sorted { $0.identifier < $1.identifier }
    }()

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        return f
    }()

    private var filteredTimezones: [TimezoneEntry] {
        let query = timezoneSearchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let source = query.isEmpty ? Self.timezoneMetadata : Self.timezoneMetadata.filter {
            $0.city.lowercased().contains(query)
            || $0.region.lowercased().contains(query)
            || $0.utcOffset.lowercased().contains(query)
            || $0.identifier.lowercased().contains(query)
        }
        let now = Date()
        let formatter = Self.timeFormatter
        return source.map { meta in
            formatter.timeZone = meta.tz
            return TimezoneEntry(
                identifier: meta.identifier, city: meta.city, region: meta.region,
                displayLabel: "\(meta.utcOffset) — \(meta.city)",
                currentTime: formatter.string(from: now),
                utcOffset: meta.utcOffset
            )
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
            VShortcutTag(shortcut)
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
