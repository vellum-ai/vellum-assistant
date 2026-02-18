import SwiftUI
import VellumAssistantShared

@MainActor
struct SettingsPanel: View {
    var onClose: () -> Void
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?
    @ObservedObject var threadManager: ThreadManager

    @State private var apiKeyText: String = ""
    @State private var braveKeyText: String = ""
    @State private var showingTrustRules = false
    @State private var showingScheduledTasks = false
    @State private var showingReminders = false
    @State private var integrations: [IPCIntegrationListResponseIntegration] = []
    @State private var connectingIntegration: String?
    @State private var integrationError: (id: String, message: String)?
    /// Tracks integrations that need setup (e.g. missing Google Cloud client ID).
    @State private var setupRequired: (id: String, skillId: String, hint: String)?
    @AppStorage("themePreference") private var themePreference: String = "system"
    @State private var accessibilityGranted: Bool = false
    @State private var screenRecordingGranted: Bool = false
    @State private var permissionCheckTask: Task<Void, Never>?
    @State private var showModelDropdown = false
    @State private var mouseDownMonitor: Any?
    @State private var modelDropdownFrame: CGRect = .zero
    @State private var newAllowlistDomain = ""
    @State private var sessionToken: String = ""
    @State private var tokenCopied: Bool = false
    #if DEBUG
    @State private var showingEnvVars = false
    @State private var appEnvVars: [(String, String)] = []
    @State private var daemonEnvVars: [(String, String)] = []
    #endif

    var body: some View {
        VSidePanel(title: "Settings", onClose: onClose) {
            VStack(alignment: .leading, spacing: VSpacing.xl) {
                // ANTHROPIC section
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("ANTHROPIC")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    if store.hasKey {
                        HStack(spacing: VSpacing.sm) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(VColor.success)
                                .font(.system(size: 14))
                            Text(store.maskedKey)
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Spacer()
                            VButton(label: "Clear", style: .danger) {
                                store.clearAPIKey()
                                apiKeyText = ""
                            }
                        }
                    } else {
                        HStack(spacing: VSpacing.xs) {
                            Text("Enter API Key")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textSecondary)
                            Image(systemName: "info.circle")
                                .font(.system(size: 12))
                                .foregroundColor(VColor.textMuted)
                        }

                        SecureField("This is your private generated key", text: $apiKeyText)
                            .textFieldStyle(.plain)
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                            .padding(VSpacing.md)
                            .background(VColor.surface)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                            )

                        Text("Get your API key at console.anthropic.com")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)

                        VButton(label: "Save", style: .primary) {
                            store.saveAPIKey(apiKeyText)
                            apiKeyText = ""
                        }
                    }
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)

                // MODEL section (only when API key is configured)
                if store.hasKey {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("MODEL")
                            .font(VFont.sectionTitle)
                            .foregroundColor(VColor.textPrimary)

                        HStack {
                            Text("Active Model")
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Spacer()
                            ModelPickerButton(
                                store: store,
                                isOpen: $showModelDropdown
                            )
                        }
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)
                    .overlay(alignment: .bottomTrailing) {
                        if showModelDropdown {
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(SettingsStore.availableModels, id: \.self) { model in
                                    ModelPickerItem(
                                        name: SettingsStore.modelDisplayNames[model] ?? model,
                                        isSelected: model == store.selectedModel
                                    ) {
                                        store.selectedModel = model
                                        store.setModel(model)
                                        withAnimation(VAnimation.fast) { showModelDropdown = false }
                                    }
                                }
                            }
                            .padding(.vertical, VSpacing.xs)
                            .background(VColor.surface)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.lg)
                                    .stroke(VColor.surfaceBorder, lineWidth: 1)
                            )
                            .shadow(color: .black.opacity(0.3), radius: 12, y: 4)
                            .fixedSize(horizontal: true, vertical: true)
                            .alignmentGuide(.bottom) { d in d[.top] }
                            .padding(.trailing, VSpacing.lg)
                            .transition(.opacity)
                            .background(
                                GeometryReader { geo in
                                    Color.clear.onAppear {
                                        modelDropdownFrame = geo.frame(in: .global)
                                    }
                                    .onChange(of: geo.frame(in: .global)) { _, newFrame in
                                        modelDropdownFrame = newFrame
                                    }
                                }
                            )
                        }
                    }
                    .animation(VAnimation.fast, value: showModelDropdown)
                    .zIndex(showModelDropdown ? 1 : 0)
                }

                // BRAVE SEARCH section
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("BRAVE SEARCH")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    if store.hasBraveKey {
                        HStack(spacing: VSpacing.sm) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(VColor.success)
                                .font(.system(size: 14))
                            Text(store.maskedBraveKey)
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Spacer()
                            VButton(label: "Clear", style: .danger) {
                                store.clearBraveKey()
                                braveKeyText = ""
                            }
                        }
                    } else {
                        HStack(spacing: VSpacing.xs) {
                            Text("Enter Brave Search API Key")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textSecondary)
                            Image(systemName: "info.circle")
                                .font(.system(size: 12))
                                .foregroundColor(VColor.textMuted)
                        }

                        SecureField("Your Brave Search API key", text: $braveKeyText)
                            .textFieldStyle(.plain)
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                            .padding(VSpacing.md)
                            .background(VColor.surface)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                            )

                        Text("Get your API key at brave.com/search/api")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)

                        VButton(label: "Save", style: .primary) {
                            store.saveBraveKey(braveKeyText)
                            braveKeyText = ""
                        }
                    }
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)

                // INTEGRATIONS section
                if daemonClient != nil {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("INTEGRATIONS")
                            .font(VFont.sectionTitle)
                            .foregroundColor(VColor.textPrimary)

                        if integrations.isEmpty {
                            Text("No integrations available")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        } else {
                            ForEach(integrations, id: \.id) { integration in
                                integrationRow(integration)
                            }
                        }
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)
                }

                // COMPUTER USAGE section
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("COMPUTER USAGE")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    HStack {
                        Text("Max Steps per Session")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Image(systemName: "info.circle")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.textMuted)
                        Spacer()
                        Text("\(Int(store.maxSteps))")
                            .font(VFont.mono)
                            .foregroundColor(VColor.textSecondary)
                    }

                    VSlider(value: $store.maxSteps, range: 1...100, step: 10, showTickMarks: true)
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)

                // DISPLAY section
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("DISPLAY")
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
                                if let delegate = NSApp.delegate as? AppDelegate {
                                    delegate.applyThemePreference()
                                }
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

                // MEDIA EMBEDS section
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("MEDIA EMBEDS")
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

                    if store.mediaEmbedsEnabled {
                        Divider()
                            .background(VColor.surfaceBorder)

                        Text("Video Domain Allowlist")
                            .font(VFont.bodyBold)
                            .foregroundColor(VColor.textSecondary)

                        HStack(spacing: VSpacing.sm) {
                            TextField("Add domain (e.g. example.com)", text: $newAllowlistDomain)
                                .textFieldStyle(.plain)
                                .font(VFont.body)
                                .foregroundColor(VColor.textPrimary)
                                .padding(VSpacing.md)
                                .background(VColor.surface)
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                                .overlay(
                                    RoundedRectangle(cornerRadius: VRadius.md)
                                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                                )

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
                            VButton(label: "Reset to Defaults", style: .ghost) {
                                store.setMediaEmbedVideoAllowlistDomains(MediaEmbedSettings.defaultDomains)
                            }
                        }
                    }
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)

                // PRIVATE THREAD section
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("PRIVATE THREAD")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    HStack {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("New Private Thread")
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Text("Private threads have isolated memory — facts learned in private threads stay private and won't appear in other conversations.")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        Spacer()
                        VButton(label: "New Private Thread", style: .primary) {
                            threadManager.createPrivateThread()
                            onClose()
                        }
                    }
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)

                // ARCHIVED THREADS section
                if !threadManager.archivedThreads.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("ARCHIVED THREADS")
                            .font(VFont.sectionTitle)
                            .foregroundColor(VColor.textPrimary)

                        ForEach(threadManager.archivedThreads) { thread in
                            HStack {
                                Text(thread.title)
                                    .font(VFont.body)
                                    .foregroundColor(VColor.textSecondary)
                                    .lineLimit(1)
                                Spacer()
                                Button(action: { threadManager.unarchiveThread(id: thread.id) }) {
                                    Text("Unarchive")
                                        .font(VFont.caption)
                                        .foregroundColor(VColor.accent)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Unarchive \(thread.title)")
                            }
                            .padding(.vertical, VSpacing.xs)
                        }
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)
                }

                // iOS DEVICE section
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("IOS DEVICE")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Session Token")
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textPrimary)
                        Text("Paste this into the Vellum iOS app to connect it to this Mac.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)

                        HStack(spacing: VSpacing.sm) {
                            if sessionToken.isEmpty {
                                Text("Token not found")
                                    .font(VFont.mono)
                                    .foregroundColor(VColor.textMuted)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            } else {
                                Text(String(sessionToken.prefix(16)) + "...")
                                    .font(VFont.mono)
                                    .foregroundColor(VColor.textSecondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }

                            Button(tokenCopied ? "Copied!" : "Copy") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(sessionToken, forType: .string)
                                tokenCopied = true
                                Task {
                                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                                    tokenCopied = false
                                }
                            }
                            .disabled(sessionToken.isEmpty)
                        }
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)
                }

                // PERMISSIONS section
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("PERMISSIONS")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    permissionRow(
                        emoji: "\u{1F47B}",
                        label: "Accessibility",
                        granted: accessibilityGranted,
                        action: {
                            // Request accessibility permission (opens System Settings)
                            _ = PermissionManager.accessibilityStatus(prompt: true)
                            startPermissionPolling()
                        }
                    )

                    permissionRow(
                        emoji: "\u{1F355}",
                        label: "Screen Recording",
                        granted: screenRecordingGranted,
                        action: {
                            // Request screen recording permission (opens System Settings)
                            PermissionManager.requestScreenRecordingAccess()
                            startPermissionPolling()
                        }
                    )
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)

                // SCHEDULED TASKS section
                if daemonClient != nil {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("SCHEDULED TASKS")
                            .font(VFont.sectionTitle)
                            .foregroundColor(VColor.textPrimary)

                        HStack {
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Manage Scheduled Tasks")
                                    .font(VFont.body)
                                    .foregroundColor(VColor.textSecondary)
                                Text("View and manage recurring tasks created by the assistant")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textMuted)
                            }
                            Spacer()
                            VButton(label: "Manage...", style: .ghost) {
                                showingScheduledTasks = true
                            }
                        }
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)
                }

                // REMINDERS section
                if daemonClient != nil {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("REMINDERS")
                            .font(VFont.sectionTitle)
                            .foregroundColor(VColor.textPrimary)

                        HStack {
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Manage Reminders")
                                    .font(VFont.body)
                                    .foregroundColor(VColor.textSecondary)
                                Text("View and manage one-shot reminders created by the assistant")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textMuted)
                            }
                            Spacer()
                            VButton(label: "Manage...", style: .ghost) {
                                showingReminders = true
                            }
                        }
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)
                }

                // TRUST RULES section
                if daemonClient != nil {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("TRUST RULES")
                            .font(VFont.sectionTitle)
                            .foregroundColor(VColor.textPrimary)

                        HStack {
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Manage Trust Rules")
                                    .font(VFont.body)
                                    .foregroundColor(VColor.textSecondary)
                                Text("Control which tool actions are automatically allowed or denied")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textMuted)
                            }
                            Spacer()
                            VButton(label: "Manage...", style: .ghost) {
                                daemonClient?.isTrustRulesSheetOpen = true
                                showingTrustRules = true
                            }
                            .disabled(store.isAnyTrustRulesSheetOpen)
                        }
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)
                }

                // PRIVACY & SECURITY section
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("PRIVACY & SECURITY")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    VStack(alignment: .leading, spacing: 0) {
                        privacyBullet(icon: "eye.slash", text: "AI only runs when you explicitly trigger it")
                        Divider().background(VColor.surfaceBorder)
                        privacyBullet(icon: "lock.shield", text: "API key stored in macOS Keychain")
                        Divider().background(VColor.surfaceBorder)
                        privacyBullet(icon: "xmark.shield", text: "Your data is not used to train AI models")
                        Divider().background(VColor.surfaceBorder)
                        privacyBullet(icon: "internaldrive", text: "Session logs and knowledge stored locally on your Mac")
                    }
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)

                #if DEBUG
                // DEVELOPER section (debug builds only)
                if daemonClient != nil {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("DEVELOPER")
                            .font(VFont.sectionTitle)
                            .foregroundColor(VColor.textPrimary)

                        HStack {
                            VStack(alignment: .leading, spacing: VSpacing.xs) {
                                Text("Environment Variables")
                                    .font(VFont.body)
                                    .foregroundColor(VColor.textSecondary)
                                Text("View env vars for both the app and daemon processes")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textMuted)
                            }
                            Spacer()
                            VButton(label: "View...", style: .ghost) {
                                appEnvVars = ProcessInfo.processInfo.environment
                                    .sorted(by: { $0.key < $1.key })
                                    .map { ($0.key, $0.value) }
                                daemonEnvVars = []
                                daemonClient?.onEnvVarsResponse = { response in
                                    Task { @MainActor in
                                        self.daemonEnvVars = response.vars
                                            .sorted(by: { $0.key < $1.key })
                                            .map { ($0.key, $0.value) }
                                    }
                                }
                                try? daemonClient?.sendEnvVarsRequest()
                                showingEnvVars = true
                            }
                        }
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)
                }
                #endif
            }
        }
        .task {
            // Refresh permission status when the view appears
            refreshPermissionStatus()
        }
        .onAppear {
            store.refreshAPIKeyState()
            setupIntegrationCallbacks()
            try? daemonClient?.sendIntegrationList()
            let tokenPath = NSHomeDirectory() + "/.vellum/session-token"
            sessionToken = (try? String(contentsOfFile: tokenPath, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        .onDisappear {
            daemonClient?.onIntegrationListResponse = nil
            daemonClient?.onIntegrationConnectResult = nil
            #if DEBUG
            daemonClient?.onEnvVarsResponse = nil
            #endif
            permissionCheckTask?.cancel()
            if let monitor = mouseDownMonitor {
                NSEvent.removeMonitor(monitor)
                mouseDownMonitor = nil
            }
        }
        .onChange(of: showModelDropdown) { _, isOpen in
            if let monitor = mouseDownMonitor {
                NSEvent.removeMonitor(monitor)
                mouseDownMonitor = nil
            }
            if isOpen {
                mouseDownMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { event in
                    // Only dismiss if the click is outside the dropdown.
                    // SwiftUI .global uses flipped coords (Y=0 at top);
                    // AppKit locationInWindow uses Y=0 at bottom.
                    if let window = event.window {
                        let windowHeight = window.frame.height
                        let loc = event.locationInWindow
                        let flippedY = windowHeight - loc.y
                        let clickPoint = CGPoint(x: loc.x, y: flippedY)
                        if !self.modelDropdownFrame.contains(clickPoint) {
                            DispatchQueue.main.async {
                                withAnimation(VAnimation.fast) { showModelDropdown = false }
                            }
                        }
                    } else {
                        DispatchQueue.main.async {
                            withAnimation(VAnimation.fast) { showModelDropdown = false }
                        }
                    }
                    return event
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            // Primary mechanism: Check permissions when app becomes active.
            // This handles the common case where the user grants permission in
            // System Settings and returns to the app via Cmd+Tab or clicking.
            // Uses NSApplication notification instead of scenePhase because this
            // view is hosted in an NSHostingController, not a SwiftUI Scene.
            refreshPermissionStatus()
        }
        .sheet(isPresented: $showingTrustRules) {
            if let daemonClient {
                TrustRulesView(daemonClient: daemonClient)
            }
        }
        .sheet(isPresented: $showingScheduledTasks) {
            if let daemonClient {
                ScheduledTasksView(daemonClient: daemonClient)
            }
        }
        .sheet(isPresented: $showingReminders) {
            if let daemonClient {
                RemindersView(daemonClient: daemonClient)
            }
        }
        #if DEBUG
        .sheet(isPresented: $showingEnvVars) {
            SettingsPanelEnvVarsSheet(appEnvVars: appEnvVars, daemonEnvVars: daemonEnvVars)
        }
        #endif
    }

    // MARK: - Integration Row

    private func integrationRow(_ integration: IPCIntegrationListResponseIntegration) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.md) {
                Text(integrationIcon(integration.id))
                    .font(.system(size: 14))
                    .frame(width: 20)

                VStack(alignment: .leading, spacing: 2) {
                    Text(integrationDisplayName(integration.id))
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                    if let account = integration.accountInfo {
                        Text(account)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    if let error = integrationError, error.id == integration.id, setupRequired?.id != integration.id {
                        Text(error.message)
                            .font(VFont.caption)
                            .foregroundColor(VColor.error)
                    }
                }

                Spacer()

                if integration.connected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                        .font(.system(size: 14))
                    VButton(label: "Disconnect", style: .danger) {
                        try? daemonClient?.sendIntegrationDisconnect(integrationId: integration.id)
                    }
                } else if connectingIntegration == integration.id {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    VButton(label: "Connect", style: .primary) {
                        integrationError = nil
                        setupRequired = nil
                        connectingIntegration = integration.id
                        do {
                            try daemonClient?.sendIntegrationConnect(integrationId: integration.id)
                        } catch {
                            connectingIntegration = nil
                        }
                    }
                }
            }

            // Setup required card — shown when integration needs configuration
            if let setup = setupRequired, setup.id == integration.id {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text(setup.hint)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    VButton(label: "Set Up \(integrationDisplayName(integration.id))", style: .primary) {
                        startIntegrationSetup(skillId: setup.skillId, integrationName: integrationDisplayName(integration.id))
                    }
                }
                .padding(.leading, 32) // Align with text after icon
            }
        }
        .padding(VSpacing.md)
        .vCard(background: VColor.surfaceSubtle)
    }

    private func integrationDisplayName(_ id: String) -> String {
        switch id {
        case "gmail": return "Gmail"
        default: return id.capitalized
        }
    }

    private func integrationIcon(_ id: String) -> String {
        switch id {
        case "gmail": return "\u{1F4E7}"
        default: return "\u{1F517}"
        }
    }

    private func setupIntegrationCallbacks() {
        daemonClient?.onIntegrationListResponse = { [self] response in
            Task { @MainActor in
                self.integrations = response.integrations
            }
        }
        daemonClient?.onIntegrationConnectResult = { [self] result in
            Task { @MainActor in
                self.connectingIntegration = nil
                if result.setupRequired == true, let skillId = result.setupSkillId {
                    // Integration needs setup — show the setup card instead of an error
                    self.integrationError = nil
                    self.setupRequired = (
                        id: result.integrationId,
                        skillId: skillId,
                        hint: result.setupHint ?? "This integration requires additional setup before it can be connected."
                    )
                } else if !result.success {
                    self.integrationError = (id: result.integrationId, message: result.error ?? "Connection failed")
                } else {
                    self.integrationError = nil
                    self.setupRequired = nil
                }
                // Refresh the list after connect/disconnect
                try? self.daemonClient?.sendIntegrationList()
            }
        }
    }

    /// Creates a new chat session with the setup skill pre-activated and navigates to it.
    private func startIntegrationSetup(skillId: String, integrationName: String) {
        guard daemonClient != nil else { return }

        // Create a new thread — its ChatViewModel will claim the session_info
        // response via correlationId.
        threadManager.createThread()

        guard let activeVM = threadManager.activeViewModel else { return }

        // Pre-activate the setup skill so the daemon deterministically
        // activates it instead of relying on model inference.
        activeVM.preactivatedSkillIds = [skillId]

        // Set the input text and send via ChatViewModel so it properly
        // bootstraps (claims session_info, sets up message loop, shows the
        // message in chat, etc.).
        activeVM.inputText = "Please set up \(integrationName) for me."
        activeVM.sendMessage()

        // Close the settings panel so the user sees the chat
        onClose()
    }

    // MARK: - Permission Row

    private func permissionRow(emoji: String, label: String, granted: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: VSpacing.md) {
                Text(emoji)
                    .font(.system(size: 14))
                    .frame(width: 20)
                    .accessibilityLabel(label)

                Text(label)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)

                Spacer()

                Image(systemName: granted ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .font(.system(size: 16))
                    .foregroundColor(granted ? VColor.success : VColor.error)
            }
            .padding(VSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .vCard(background: VColor.surfaceSubtle)
        .onHover { hovering in
            if hovering {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }

    // MARK: - Permission Helpers

    private func refreshPermissionStatus() {
        accessibilityGranted = PermissionManager.accessibilityStatus() == .granted
        screenRecordingGranted = PermissionManager.screenRecordingStatus() == .granted
    }

    private func startPermissionPolling() {
        // Hybrid permission checking approach:
        // 1. Primary: NSApplication.didBecomeActiveNotification detects when user
        //    returns from System Settings
        // 2. Fallback: Poll every 1 second for 15 seconds to catch edge cases where
        //    the notification doesn't fire (e.g., user grants permission while app
        //    stays focused)
        //
        // Polling stops early if both permissions are granted, minimizing overhead.
        permissionCheckTask?.cancel()

        permissionCheckTask = Task { @MainActor in
            // Poll for up to 15 seconds (typical time for user to navigate System Settings)
            for _ in 0..<15 {
                try? await Task.sleep(nanoseconds: 1_000_000_000) // 1 second

                guard !Task.isCancelled else { return }
                refreshPermissionStatus()

                // Stop polling if both permissions are granted
                if accessibilityGranted && screenRecordingGranted {
                    return
                }
            }
        }
    }

    // MARK: - Privacy Bullet

    private func privacyBullet(icon: String, text: String) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundColor(VColor.textMuted)
                .frame(width: 16)
            Text(text)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
        .padding(.vertical, VSpacing.md)
    }

}

// MARK: - Custom Model Picker

private struct ModelPickerButton: View {
    @ObservedObject var store: SettingsStore
    @Binding var isOpen: Bool
    @State private var isHovered = false

    var body: some View {
        Button {
            withAnimation(VAnimation.fast) { isOpen.toggle() }
        } label: {
            HStack(spacing: VSpacing.sm) {
                Text(SettingsStore.modelDisplayNames[store.selectedModel] ?? store.selectedModel)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(VColor.textMuted)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(isHovered ? VColor.hoverOverlay.opacity(0.06) : VColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}

private struct ModelPickerItem: View {
    let name: String
    let isSelected: Bool
    let onSelect: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: VSpacing.md) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isSelected ? VColor.accent : (isHovered ? VColor.textPrimary : VColor.textSecondary))
                    .frame(width: 18)
                Text(name)
                    .font(isSelected ? VFont.bodyBold : VFont.body)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(isHovered ? VColor.hoverOverlay.opacity(0.06) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}

// MARK: - Environment Variables Sheet (Debug Only)

#if DEBUG
private struct SettingsPanelEnvVarsSheet: View {
    let appEnvVars: [(String, String)]
    let daemonEnvVars: [(String, String)]
    @Environment(\.dismiss) var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Environment Variables")
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                VButton(label: "Done", style: .ghost) { dismiss() }
            }
            .padding(VSpacing.lg)

            Divider().background(VColor.surfaceBorder)

            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    envVarsSection(title: "APP PROCESS", vars: appEnvVars)
                    envVarsSection(title: "DAEMON PROCESS", vars: daemonEnvVars)
                }
                .padding(VSpacing.lg)
            }
        }
        .frame(width: 600, height: 500)
        .background(VColor.background)
    }

    private func envVarsSection(title: String, vars: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text(title)
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)
            if vars.isEmpty {
                Text("Loading...")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            } else {
                ForEach(vars, id: \.0) { key, value in
                    HStack(alignment: .top, spacing: VSpacing.sm) {
                        Text(key)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.textSecondary)
                            .frame(width: 200, alignment: .trailing)
                        Text(value)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.textMuted)
                            .textSelection(.enabled)
                        Spacer()
                    }
                }
            }
        }
    }
}
#endif

struct SettingsPanel_Previews: PreviewProvider {
    static var previews: some View {
        let dc = DaemonClient()
        ZStack {
            VColor.background.ignoresSafeArea()
            SettingsPanel(onClose: {}, store: SettingsStore(daemonClient: dc), threadManager: ThreadManager(daemonClient: dc))
        }
        .frame(width: 600, height: 700)
    }
}
