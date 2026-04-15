import SwiftUI
import VellumAssistantShared

/// Appearance settings tab — theme selection, keyboard shortcuts, and media embed configuration.
struct SettingsAppearanceTab: View {
    private static let knownTimezones: [String] = TimeZone.knownTimeZoneIdentifiers.sorted()

    @ObservedObject var store: SettingsStore
    @State private var newAllowlistDomain = ""
    @State private var isVideoDomainsExpanded: Bool = false
    @State private var isRecordingGlobalHotkey = false
    @State private var isRecordingQuickInputHotkey = false
    @State private var isRecordingSidebarToggle = false
    @State private var isRecordingNewChat = false
    @State private var isRecordingCurrentConversation = false
    @State private var isRecordingMarkConversationUnread = false
    @State private var isRecordingPopOut = false
    @State private var isRecordingVoiceInput = false
    @State private var shortcutMonitor: Any?
    @State private var flagsMonitor: Any?
    @State private var recordingDisplayString: String?
    @State private var shortcutConflictWarning: String?
    @State private var voiceRecordingMonitors: [Any] = []
    @State private var voiceModifierHoldTimer: Timer? = nil
    @State private var selectedTimezone: String = ""
    @State private var timezoneSearchText: String = ""
    @State private var debouncedTimezoneSearchText: String = ""
    @State private var isTimezoneDropdownOpen: Bool = false
    @State private var timezoneSearchDebounceTask: Task<Void, Never>?
    @AppStorage("activationKey") private var activationKey: String = "fn"
    @AppStorage("themePreference") private var themePreference: String = "system"
    @FocusState private var isTimezoneSearchFocused: Bool

    private var themeBinding: Binding<String> {
        Binding(
            get: { themePreference },
            set: { themePreference = $0; VTheme.applyTheme($0) }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // THEME section
            SettingsCard(title: "Theme") {
                VSegmentControl(
                    items: [
                        (label: "System", tag: "system"),
                        (label: "Light", tag: "light"),
                        (label: "Dark", tag: "dark"),
                    ],
                    selection: themeBinding
                )
                .frame(width: 248)
            }

            // TIMEZONE section
            SettingsCard(title: "Timezone") {
                // Searchable timezone picker
                VStack(spacing: 0) {
                    HStack {
                        Text("Closest city")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentSecondary)
                        Spacer()
                        VSearchBar(placeholder: selectedCityPlaceholder, text: $timezoneSearchText)
                            .focused($isTimezoneSearchFocused)
                            .frame(width: 280)
                    }
                    .onChange(of: timezoneSearchText) { _, newValue in
                        isTimezoneDropdownOpen = !newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        timezoneSearchDebounceTask?.cancel()
                        timezoneSearchDebounceTask = Task { @MainActor in
                            try? await Task.sleep(nanoseconds: 200_000_000)
                            guard !Task.isCancelled else { return }
                            debouncedTimezoneSearchText = newValue
                        }
                    }
                    .onChange(of: isTimezoneSearchFocused) { _, focused in
                        if focused && timezoneSearchText.isEmpty {
                            // Show all when focused with empty search
                            isTimezoneDropdownOpen = true
                        } else if !focused {
                            isTimezoneDropdownOpen = false
                        }
                    }
                    .onExitCommand {
                        isTimezoneDropdownOpen = false
                        isTimezoneSearchFocused = false
                        timezoneSearchText = ""
                    }

                    if isTimezoneDropdownOpen {
                        let filtered = filteredTimezones
                        if !filtered.isEmpty {
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: VSpacing.xs) {
                                    ForEach(filtered, id: \.identifier) { entry in
                                        TimezoneResultRow(
                                            entry: entry,
                                            isSelected: entry.identifier == selectedTimezone,
                                            onSelect: {
                                                selectedTimezone = entry.identifier
                                                timezoneSearchText = ""
                                                isTimezoneDropdownOpen = false
                                                isTimezoneSearchFocused = false
                                            }
                                        )
                                    }
                                }
                                .padding(VSpacing.sm)
                                .background { OverlayScrollerStyle() }
                            }
                            .scrollContentBackground(.hidden)
                            .frame(maxHeight: 200)
                            .background(VColor.surfaceLift)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                            .vShadow(VShadow.modalNear)
                            .vShadow(VShadow.modalFar)
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
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                    Spacer()
                    Text(timezoneDisplayName)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentDefault)
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

            // KEYBOARD SHORTCUTS section
            SettingsCard(title: "Keyboard Shortcuts") {
                VStack(alignment: .leading, spacing: 0) {

                // Open Vellum (configurable)
                HStack {
                    Text("Open Vellum")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                    Spacer()
                    if isRecordingGlobalHotkey, let display = recordingDisplayString, !display.isEmpty {
                        VShortcutTag(display)
                    } else {
                        VShortcutTag(ShortcutHelper.displayString(for: store.globalHotkeyShortcut))
                    }

                    if isRecordingGlobalHotkey {
                        VButton(label: "Press shortcut...", style: .outlined) {
                            stopRecording()
                        }
                    } else {
                        HStack(spacing: VSpacing.sm) {
                            VButton(label: "Change", style: .outlined) {
                                startRecording()
                            }
                            if !store.globalHotkeyShortcut.isEmpty {
                                VButton(label: "Remove", style: .outlined) {
                                    store.globalHotkeyShortcut = ""
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, VSpacing.md)

                if let shortcutConflictWarning {
                    Text(shortcutConflictWarning)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.systemNegativeHover)
                        .padding(.bottom, VSpacing.xs)
                }

                SettingsDivider()

                // Quick Input (configurable)
                HStack {
                    Text("Quick Input")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                    Spacer()
                    if isRecordingQuickInputHotkey, let display = recordingDisplayString, !display.isEmpty {
                        VShortcutTag(display)
                    } else {
                        VShortcutTag(ShortcutHelper.displayString(for: store.quickInputHotkeyShortcut))
                    }

                    if isRecordingQuickInputHotkey {
                        VButton(label: "Press shortcut...", style: .outlined) {
                            stopRecording()
                        }
                    } else {
                        HStack(spacing: VSpacing.sm) {
                            VButton(label: "Change", style: .outlined) {
                                startRecordingQuickInput()
                            }
                            if !store.quickInputHotkeyShortcut.isEmpty {
                                VButton(label: "Remove", style: .outlined) {
                                    store.quickInputHotkeyShortcut = ""
                                    store.quickInputHotkeyKeyCode = 0
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, VSpacing.md)

                SettingsDivider()

                HStack {
                    Text("Start voice input")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                    Spacer()
                    // Read activationKey to establish SwiftUI dependency tracking
                    let activator = { _ = activationKey; return PTTActivator.cached }()

                    if isRecordingVoiceInput {
                        VShortcutTag("Press key...")
                        VButton(label: "Cancel", style: .outlined) {
                            stopRecordingVoiceInput()
                        }
                    } else {
                        VShortcutTag(activator.kind != .none ? "Hold \(activator.displayName)" : "Disabled")
                        HStack(spacing: VSpacing.sm) {
                            VButton(label: "Change", style: .outlined) {
                                startRecordingVoiceInput()
                            }
                            if activator.kind != .none {
                                VButton(label: "Remove", style: .outlined) {
                                    PTTActivator.off.store()
                                    PTTActivator.updateCache(.off)
                                    activationKey = "none"
                                    NotificationCenter.default.post(name: .activationKeyChanged, object: nil)
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, VSpacing.md)

                SettingsDivider()

                // New chat (configurable)
                HStack {
                    Text("New chat")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                    Spacer()
                    if isRecordingNewChat, let display = recordingDisplayString, !display.isEmpty {
                        VShortcutTag(display)
                    } else {
                        VShortcutTag(ShortcutHelper.displayString(for: store.newChatShortcut))
                    }

                    if isRecordingNewChat {
                        VButton(label: "Press shortcut...", style: .outlined) {
                            stopRecording()
                        }
                    } else {
                        HStack(spacing: VSpacing.sm) {
                            VButton(label: "Change", style: .outlined) {
                                startRecordingNewChat()
                            }
                            if !store.newChatShortcut.isEmpty {
                                VButton(label: "Remove", style: .outlined) {
                                    store.newChatShortcut = ""
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, VSpacing.md)

                SettingsDivider()

                // Current conversation (configurable)
                HStack {
                    Text("Current conversation")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                    Spacer()
                    if isRecordingCurrentConversation, let display = recordingDisplayString, !display.isEmpty {
                        VShortcutTag(display)
                    } else {
                        VShortcutTag(ShortcutHelper.displayString(for: store.currentConversationShortcut))
                    }

                    if isRecordingCurrentConversation {
                        VButton(label: "Press shortcut...", style: .outlined) {
                            stopRecording()
                        }
                    } else {
                        HStack(spacing: VSpacing.sm) {
                            VButton(label: "Change", style: .outlined) {
                                startRecordingCurrentConversation()
                            }
                            if !store.currentConversationShortcut.isEmpty {
                                VButton(label: "Remove", style: .outlined) {
                                    store.currentConversationShortcut = ""
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, VSpacing.md)

                SettingsDivider()

                // Mark conversation as unread (configurable)
                HStack {
                    Text("Mark conversation as unread")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                    Spacer()
                    if isRecordingMarkConversationUnread, let display = recordingDisplayString, !display.isEmpty {
                        VShortcutTag(display)
                    } else {
                        VShortcutTag(ShortcutHelper.displayString(for: store.markConversationUnreadShortcut))
                    }

                    if isRecordingMarkConversationUnread {
                        VButton(label: "Press shortcut...", style: .outlined) {
                            stopRecording()
                        }
                    } else {
                        HStack(spacing: VSpacing.sm) {
                            VButton(label: "Change", style: .outlined) {
                                startRecordingMarkConversationUnread()
                            }
                            if !store.markConversationUnreadShortcut.isEmpty {
                                VButton(label: "Remove", style: .outlined) {
                                    store.markConversationUnreadShortcut = ""
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, VSpacing.md)

                SettingsDivider()

                // Toggle sidebar (configurable)
                HStack {
                    Text("Toggle sidebar")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                    Spacer()
                    if isRecordingSidebarToggle, let display = recordingDisplayString, !display.isEmpty {
                        VShortcutTag(display)
                    } else {
                        VShortcutTag(ShortcutHelper.displayString(for: store.sidebarToggleShortcut))
                    }

                    if isRecordingSidebarToggle {
                        VButton(label: "Press shortcut...", style: .outlined) {
                            stopRecording()
                        }
                    } else {
                        HStack(spacing: VSpacing.sm) {
                            VButton(label: "Change", style: .outlined) {
                                startRecordingSidebarToggle()
                            }
                            if !store.sidebarToggleShortcut.isEmpty {
                                VButton(label: "Remove", style: .outlined) {
                                    store.sidebarToggleShortcut = ""
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, VSpacing.md)

                SettingsDivider()

                // Pop out conversation (configurable)
                HStack {
                    Text("Pop out conversation")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                    Spacer()
                    if isRecordingPopOut, let display = recordingDisplayString, !display.isEmpty {
                        VShortcutTag(display)
                    } else {
                        VShortcutTag(ShortcutHelper.displayString(for: store.popOutShortcut))
                    }

                    if isRecordingPopOut {
                        VButton(label: "Press shortcut...", style: .outlined) {
                            stopRecording()
                        }
                    } else {
                        HStack(spacing: VSpacing.sm) {
                            VButton(label: "Change", style: .outlined) {
                                startRecordingPopOut()
                            }
                            if !store.popOutShortcut.isEmpty {
                                VButton(label: "Remove", style: .outlined) {
                                    store.popOutShortcut = ""
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, VSpacing.md)

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
                stopRecordingVoiceInput()
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

                    VDisclosureSection(
                        title: "Video Domain Allowlist",
                        isExpanded: $isVideoDomainsExpanded
                    ) {
                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Add Domain")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentTertiary)

                                HStack(spacing: VSpacing.sm) {
                                    VTextField(
                                        placeholder: "Add domain (e.g. example.com)",
                                        text: $newAllowlistDomain,
                                        onSubmit: { addAllowlistDomain() }
                                    )

                                    VButton(label: "Add", style: .primary, isDisabled: newAllowlistDomain.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                                        addAllowlistDomain()
                                    }
                                }
                            }

                            ForEach(store.mediaEmbedVideoAllowlistDomains, id: \.self) { domain in
                                HStack {
                                    Text(domain)
                                        .font(VFont.bodyMediumLighter)
                                        .foregroundStyle(VColor.contentDefault)
                                        .textSelection(.enabled)
                                    Spacer()
                                    VButton(label: "Remove domain", iconOnly: VIcon.trash.rawValue, style: .danger) {
                                        var domains = store.mediaEmbedVideoAllowlistDomains
                                        domains.removeAll { $0 == domain }
                                        store.setMediaEmbedVideoAllowlistDomains(domains)
                                    }
                                }
                                .padding(.horizontal, VSpacing.md)
                                .padding(.vertical, VSpacing.sm)
                                .overlay(
                                    RoundedRectangle(cornerRadius: VRadius.lg)
                                        .strokeBorder(VColor.borderBase, lineWidth: 1)
                                )
                            }
                        }
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

    fileprivate struct TimezoneEntry {
        let identifier: String
        let city: String
        let region: String
        let displayLabel: String
        let currentTime: String
        let utcOffset: String
    }

    /// Stable timezone metadata (city, region) — computed once. Time-sensitive fields computed on access.
    private struct TimezoneMetadata {
        let identifier: String
        let city: String
        let region: String
        let tz: TimeZone
    }

    private var selectedCityPlaceholder: String {
        guard !selectedTimezone.isEmpty,
              TimeZone(identifier: selectedTimezone) != nil else {
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

    /// Stable metadata cached once; time-sensitive fields (offset, currentTime) computed on access.
    private static let timezoneMetadata: [TimezoneMetadata] = {
        knownTimezones.compactMap { id -> TimezoneMetadata? in
            guard let tz = TimeZone(identifier: id) else { return nil }
            let parts = id.components(separatedBy: "/")
            let city = (parts.last ?? id).replacingOccurrences(of: "_", with: " ")
            let region = parts.count > 1 ? parts[0].replacingOccurrences(of: "_", with: " ") : ""
            return TimezoneMetadata(identifier: id, city: city, region: region, tz: tz)
        }
        .sorted { $0.identifier < $1.identifier }
    }()

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        return f
    }()

    private static func utcOffsetString(for tz: TimeZone) -> String {
        let seconds = tz.secondsFromGMT()
        let hours = seconds / 3600
        let minutes = abs(seconds % 3600) / 60
        return minutes > 0
            ? String(format: "GMT%+d:%02d", hours, minutes)
            : String(format: "GMT%+d", hours)
    }

    private var filteredTimezones: [TimezoneEntry] {
        let now = Date()
        let formatter = Self.timeFormatter
        let query = debouncedTimezoneSearchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        return Self.timezoneMetadata.compactMap { meta in
            let offset = Self.utcOffsetString(for: meta.tz)

            if !query.isEmpty {
                guard meta.city.lowercased().contains(query)
                    || meta.region.lowercased().contains(query)
                    || offset.lowercased().contains(query)
                    || meta.identifier.lowercased().contains(query)
                else { return nil }
            }

            formatter.timeZone = meta.tz
            return TimezoneEntry(
                identifier: meta.identifier, city: meta.city, region: meta.region,
                displayLabel: "\(offset) — \(meta.city)",
                currentTime: formatter.string(from: now),
                utcOffset: offset
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

    private func startRecordingSidebarToggle() {
        startRecordingShortcut { shortcut, _ in
            store.sidebarToggleShortcut = shortcut
        }
        isRecordingSidebarToggle = true
    }

    private func startRecordingNewChat() {
        startRecordingShortcut { shortcut, _ in
            store.newChatShortcut = shortcut
        }
        isRecordingNewChat = true
    }

    private func startRecordingCurrentConversation() {
        startRecordingShortcut { shortcut, _ in
            store.currentConversationShortcut = shortcut
        }
        isRecordingCurrentConversation = true
    }

    private func startRecordingMarkConversationUnread() {
        startRecordingShortcut { shortcut, _ in
            store.markConversationUnreadShortcut = shortcut
        }
        isRecordingMarkConversationUnread = true
    }

    private func startRecordingPopOut() {
        startRecordingShortcut { shortcut, _ in
            store.popOutShortcut = shortcut
        }
        isRecordingPopOut = true
    }

    /// Shared recording logic. The callback receives the shortcut string and the raw NSEvent key code.
    private func startRecordingShortcut(onRecord: @escaping (String, UInt16) -> Void) {
        stopRecording()
        stopRecordingVoiceInput()
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
        isRecordingSidebarToggle = false
        isRecordingNewChat = false
        isRecordingCurrentConversation = false
        isRecordingMarkConversationUnread = false
        isRecordingPopOut = false
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

    // MARK: - Voice Input Recording

    private func selectVoiceActivator(_ newActivator: PTTActivator) {
        stopRecordingVoiceInput()
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

    private func startRecordingVoiceInput() {
        stopRecording()
        stopRecordingVoiceInput()
        isRecordingVoiceInput = true

        let globalFlags = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [self] event in
            handleVoiceRecordingFlagsChanged(event)
        }
        let localFlags = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [self] event in
            handleVoiceRecordingFlagsChanged(event)
            return event
        }

        let globalKeyDown = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [self] event in
            handleVoiceRecordingKeyDown(event)
        }
        let localKeyDown = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [self] event in
            if handleVoiceRecordingKeyDown(event) {
                return nil
            }
            return event
        }

        if let m = globalFlags { voiceRecordingMonitors.append(m) }
        if let m = localFlags { voiceRecordingMonitors.append(m) }
        if let m = globalKeyDown { voiceRecordingMonitors.append(m) }
        if let m = localKeyDown { voiceRecordingMonitors.append(m) }
    }

    private func stopRecordingVoiceInput() {
        isRecordingVoiceInput = false
        voiceModifierHoldTimer?.invalidate()
        voiceModifierHoldTimer = nil
        for monitor in voiceRecordingMonitors {
            NSEvent.removeMonitor(monitor)
        }
        voiceRecordingMonitors = []
    }

    private func handleVoiceRecordingFlagsChanged(_ event: NSEvent) {
        voiceModifierHoldTimer?.invalidate()
        voiceModifierHoldTimer = nil

        let relevant: NSEvent.ModifierFlags = [.command, .shift, .control, .option, .function]
        let held = event.modifierFlags.intersection(relevant)

        guard !held.isEmpty else { return }

        voiceModifierHoldTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [self] _ in
            selectVoiceActivator(.modifierOnly(flags: held))
        }
    }

    @discardableResult
    private func handleVoiceRecordingKeyDown(_ event: NSEvent) -> Bool {
        guard !event.isARepeat else { return false }

        if event.keyCode == 53 {
            stopRecordingVoiceInput()
            return true
        }

        voiceModifierHoldTimer?.invalidate()
        voiceModifierHoldTimer = nil

        let relevant: NSEvent.ModifierFlags = [.command, .shift, .control, .option, .function]
        let held = event.modifierFlags.intersection(relevant)

        let activator: PTTActivator
        if held.isEmpty {
            activator = .key(code: event.keyCode)
        } else {
            activator = .modifierKey(code: event.keyCode, flags: held)
        }

        selectVoiceActivator(activator)
        return true
    }

}

// MARK: - Timezone Result Row

private struct TimezoneResultRow: View {
    let entry: SettingsAppearanceTab.TimezoneEntry
    let isSelected: Bool
    let onSelect: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: onSelect) {
            HStack {
                Text(entry.displayLabel)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(isSelected ? VColor.contentEmphasized : VColor.contentSecondary)
                Spacer()
                Text(entry.currentTime)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .frame(minHeight: VSize.rowMinHeight)
            .background(
                isSelected ? VColor.surfaceActive :
                isHovered ? VColor.surfaceBase :
                Color.clear
            )
            .animation(VAnimation.fast, value: isHovered)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .pointerCursor()
    }
}

