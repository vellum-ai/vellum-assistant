import SwiftUI
import VellumAssistantShared

enum SettingsTab: String, CaseIterable {
    case integrations = "Integrations"
    case trust = "Trust"
    case reminders = "Reminders"
    case appearance = "Appearance"
    case advanced = "Advanced"
}

@MainActor
struct SettingsPanel: View {
    var onClose: () -> Void
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?
    @ObservedObject var threadManager: ThreadManager

    @State private var apiKeyText: String = ""
    @State private var braveKeyText: String = ""
    @State private var perplexityKeyText: String = ""
    @State private var imageGenKeyText: String = ""
    @State private var openaiKeyText: String = ""
    @State private var elevenLabsKeyText: String = ""
    @State private var showingTrustRules = false
    @State private var showingReminders = false
    @State private var twitterClientId: String = ""
    @State private var twitterClientSecret: String = ""
    @State private var telegramBotTokenText: String = ""
    @State private var twilioAccountSidText: String = ""
    @State private var twilioAuthTokenText: String = ""
    @State private var twilioPhoneNumberText: String = ""
    @State private var twilioAreaCodeText: String = ""
    @State private var twilioCountryText: String = "US"
    @State private var ingressUrlText: String = ""
    @FocusState private var isIngressUrlFocused: Bool
    @State private var checkingGateway: Bool = false
    @State private var gatewayHealthResult: Bool? = nil
    @State private var integrations: [IPCIntegrationListResponseIntegration] = []
    @State private var connectingIntegration: String?
    @State private var integrationError: (id: String, message: String)?
    /// Tracks integrations that need setup (e.g. missing Google Cloud client ID).
    @State private var setupRequired: (id: String, skillId: String, hint: String)?
    @State private var accessibilityGranted: Bool = false
    @State private var screenRecordingGranted: Bool = false
    @State private var permissionCheckTask: Task<Void, Never>?
    @State private var showModelDropdown = false
    @State private var mouseDownMonitor: Any?
    @State private var modelDropdownFrame: CGRect = .zero
    @State private var selectedTab: SettingsTab = .integrations
    @State private var testerModel: ToolPermissionTesterModel?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header (matches VSidePanel style)
            HStack {
                Text("Settings")
                    .font(VFont.panelTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(VColor.textMuted)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close Settings")
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.lg)

            Divider()
                .background(VColor.surfaceBorder)

            // Two-column layout
            HStack(spacing: 0) {
                // Left: nav sidebar
                settingsNav
                    .frame(width: 160)

                Divider()

                // Right: content for selected tab
                ScrollView {
                    selectedTabContent
                        .padding(VSpacing.lg)
                        .frame(maxWidth: .infinity, alignment: .top)
                }
            }
        }
        .background(VColor.backgroundSubtle)
        .task {
            // Refresh permission status when the view appears
            refreshPermissionStatus()
        }
        .onAppear {
            store.refreshAPIKeyState()
            store.refreshTwitterStatus()
            store.refreshTelegramStatus()
            store.refreshTwilioStatus()
            store.refreshIngressConfig()
            ingressUrlText = store.ingressPublicBaseUrl
            setupIntegrationCallbacks()
            try? daemonClient?.sendIntegrationList()
            if testerModel == nil, let dc = daemonClient {
                testerModel = ToolPermissionTesterModel(daemonClient: dc)
            }
        }
        .onDisappear {
            daemonClient?.onIntegrationListResponse = nil
            daemonClient?.onIntegrationConnectResult = nil
            permissionCheckTask?.cancel()
            if let monitor = mouseDownMonitor {
                NSEvent.removeMonitor(monitor)
                mouseDownMonitor = nil
            }
        }
        .onChange(of: store.ingressPublicBaseUrl) { _, newValue in
            // Only sync from store when the field is not focused, so
            // background IPC responses don't overwrite in-progress edits.
            if !isIngressUrlFocused {
                ingressUrlText = newValue
            }
        }
        .onChange(of: isIngressUrlFocused) { _, focused in
            // Re-sync when focus leaves so any updates skipped while the
            // user was editing are applied once they're done.
            if !focused {
                ingressUrlText = store.ingressPublicBaseUrl
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
        .sheet(isPresented: $showingReminders) {
            if let daemonClient {
                RemindersView(daemonClient: daemonClient)
            }
        }
    }

    // MARK: - Nav Sidebar

    private var settingsNav: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            ForEach(SettingsTab.allCases, id: \.self) { tab in
                SettingsNavRow(tab: tab, isSelected: selectedTab == tab) {
                    selectedTab = tab
                }
            }
            Spacer()
        }
        .padding(VSpacing.lg)
    }

    // MARK: - Tab Content Router

    @ViewBuilder
    private var selectedTabContent: some View {
        switch selectedTab {
        case .integrations:
            integrationsContent
        case .trust:
            trustContent
        case .reminders:
            remindersContent
        case .appearance:
            SettingsAppearanceTab(store: store)
        case .advanced:
            SettingsAdvancedTab(
                store: store,
                threadManager: threadManager,
                onClose: onClose,
                daemonClient: daemonClient
            )
        }
    }

    // MARK: - Integrations Tab

    private var integrationsContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            // ANTHROPIC section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Anthropic")
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

                if store.hasKey {
                    Divider()
                        .background(VColor.surfaceBorder)

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

            // PUBLIC INGRESS section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                HStack {
                    Text("Public Ingress")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)
                    Spacer()
                    Toggle("", isOn: Binding(
                        get: { store.ingressEnabled },
                        set: { store.setIngressEnabled($0) }
                    ))
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .disabled(store.ingressPublicBaseUrl.isEmpty && !store.ingressEnabled)
                }

                HStack(alignment: .top, spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 12))
                    Text("Setting a public base URL may expose this computer to the public internet. Use with caution.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }

                // Public Ingress URL field
                HStack(spacing: VSpacing.xs) {
                    Text("Public Ingress URL")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }

                TextField("https://abc123.ngrok-free.app", text: $ingressUrlText)
                    .focused($isIngressUrlFocused)
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

                VButton(label: "Save", style: .primary) {
                    store.saveIngressPublicBaseUrl(ingressUrlText)
                }

                Divider()
                    .background(VColor.surfaceBorder)

                // Local Gateway Target (read-only)
                HStack(spacing: VSpacing.xs) {
                    Text("Local Gateway Target")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }

                HStack(spacing: VSpacing.sm) {
                    Text(store.localGatewayTarget)
                        .font(VFont.mono)
                        .foregroundColor(VColor.textPrimary)
                        .textSelection(.enabled)
                        .padding(VSpacing.md)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(VColor.surface.opacity(0.5))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.surfaceBorder.opacity(0.3), lineWidth: 1)
                        )

                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(store.localGatewayTarget, forType: .string)
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(VColor.textSecondary)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy gateway address")
                    .help("Copy address")

                    // Check Gateway button
                    Button {
                        checkGatewayHealth()
                    } label: {
                        if checkingGateway {
                            ProgressView()
                                .controlSize(.small)
                                .frame(width: 28, height: 28)
                        } else {
                            Image(systemName: "antenna.radiowaves.left.and.right")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundColor(VColor.textSecondary)
                                .frame(width: 28, height: 28)
                                .contentShape(Rectangle())
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(checkingGateway)
                    .accessibilityLabel("Check gateway health")
                    .help("Check gateway health")
                }

                if let reachable = gatewayHealthResult {
                    HStack(spacing: VSpacing.sm) {
                        Image(systemName: reachable ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundColor(reachable ? VColor.success : VColor.error)
                        Text(reachable ? "Gateway is reachable" : "Gateway is not reachable")
                            .font(VFont.caption)
                            .foregroundColor(reachable ? VColor.success : VColor.error)
                    }
                    .transition(.opacity)
                }

                Text("Point your tunnel service at this local address.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)

            // PERPLEXITY SEARCH section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Perplexity Search")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                if store.hasPerplexityKey {
                    HStack(spacing: VSpacing.sm) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(VColor.success)
                            .font(.system(size: 14))
                        Text(store.maskedPerplexityKey)
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        VButton(label: "Clear", style: .danger) {
                            store.clearPerplexityKey()
                            perplexityKeyText = ""
                        }
                    }
                } else {
                    HStack(spacing: VSpacing.xs) {
                        Text("Enter Perplexity API Key")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                        Image(systemName: "info.circle")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.textMuted)
                    }

                    SecureField("Your Perplexity API key", text: $perplexityKeyText)
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

                    Text("Get your API key at perplexity.ai/settings/api")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)

                    VButton(label: "Save", style: .primary) {
                        store.savePerplexityKey(perplexityKeyText)
                        perplexityKeyText = ""
                    }
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)

            // BRAVE SEARCH section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Brave Search")
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

            // IMAGE GENERATION section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Image Generation")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                if store.hasImageGenKey {
                    HStack(spacing: VSpacing.sm) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(VColor.success)
                            .font(.system(size: 14))
                        Text(store.maskedImageGenKey)
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        VButton(label: "Clear", style: .danger) {
                            store.clearImageGenKey()
                            imageGenKeyText = ""
                        }
                    }

                    HStack {
                        Text("Model")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        Picker("", selection: Binding(
                            get: { store.selectedImageGenModel },
                            set: { store.setImageGenModel($0) }
                        )) {
                            ForEach(SettingsStore.availableImageGenModels, id: \.self) { model in
                                Text(SettingsStore.imageGenModelDisplayNames[model] ?? model)
                                    .tag(model)
                            }
                        }
                        .labelsHidden()
                        .fixedSize()
                    }
                } else {
                    HStack(spacing: VSpacing.xs) {
                        Text("Enter Gemini API Key")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                        Image(systemName: "info.circle")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.textMuted)
                    }

                    SecureField("Your Gemini API key", text: $imageGenKeyText)
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

                    Text("Get your API key at aistudio.google.com/apikey")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)

                    VButton(label: "Save", style: .primary) {
                        store.saveImageGenKey(imageGenKeyText)
                        imageGenKeyText = ""
                    }
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)

            // OPENAI section (for Voice Mode — Whisper + TTS)
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("OpenAI")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                if store.hasOpenAIKey {
                    HStack(spacing: VSpacing.sm) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(VColor.success)
                            .font(.system(size: 14))
                        Text(store.maskedOpenAIKey)
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        VButton(label: "Clear", style: .danger) {
                            store.clearOpenAIKey()
                            openaiKeyText = ""
                        }
                    }
                } else {
                    HStack(spacing: VSpacing.xs) {
                        Text("Enter OpenAI API Key")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                        Image(systemName: "info.circle")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.textMuted)
                    }

                    SecureField("Your OpenAI API key", text: $openaiKeyText)
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

                    Text("Used for Voice Mode (Whisper transcription). Get your key at platform.openai.com/api-keys")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)

                    VButton(label: "Save", style: .primary) {
                        store.saveOpenAIKey(openaiKeyText)
                        openaiKeyText = ""
                    }
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)

            // ELEVENLABS section (for Voice Mode TTS)
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("ElevenLabs")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                if store.hasElevenLabsKey {
                    HStack(spacing: VSpacing.sm) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(VColor.success)
                            .font(.system(size: 14))
                        Text(store.maskedElevenLabsKey)
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        VButton(label: "Clear", style: .danger) {
                            store.clearElevenLabsKey()
                            elevenLabsKeyText = ""
                        }
                    }
                } else {
                    HStack(spacing: VSpacing.xs) {
                        Text("Enter ElevenLabs API Key")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                        Image(systemName: "info.circle")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.textMuted)
                    }

                    SecureField("Your ElevenLabs API key", text: $elevenLabsKeyText)
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

                    Text("Used for Voice Mode (text-to-speech). Get your key at elevenlabs.io/app/settings/api-keys")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)

                    VButton(label: "Save", style: .primary) {
                        store.saveElevenLabsKey(elevenLabsKeyText)
                        elevenLabsKeyText = ""
                    }
                }
            }
            .padding(VSpacing.lg)
            .vCard(background: VColor.surfaceSubtle)

            // INTEGRATIONS section (hidden when empty)
            if daemonClient != nil && !integrations.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Integrations")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    ForEach(integrations, id: \.id) { integration in
                        integrationRow(integration)
                    }
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)
            }

            // TWITTER / X section
            twitterSection

            // TELEGRAM section
            telegramSection

            // TWILIO / SMS section
            twilioSection
        }
    }

    // MARK: - Twitter Section

    private var twitterSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Twitter / X")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            // Mode Picker
            HStack {
                Text("Integration mode")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
                Picker("", selection: $store.twitterMode) {
                    Text("Local (BYO App)").tag("local_byo")
                    Text("Managed").tag("managed")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .onChange(of: store.twitterMode) { _, newValue in
                    store.setTwitterMode(newValue)
                }
            }

            // Managed mode "coming soon" card
            if store.twitterMode == "managed" {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "info.circle")
                        .foregroundStyle(VColor.textSecondary)
                    Text("Managed mode is coming soon. Switch to Local (BYO App) to connect now.")
                        .font(VFont.caption)
                        .foregroundStyle(VColor.textSecondary)
                }
            }

            // Local BYO mode content
            if store.twitterMode == "local_byo" {
                if !store.twitterLocalClientConfigured {
                    // Client credentials entry (when not yet configured)
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        TextField("OAuth Client ID", text: $twitterClientId)
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

                        SecureField("OAuth Client Secret (optional)", text: $twitterClientSecret)
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

                        HStack {
                            Text("Create an app at developer.x.com")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                            Spacer()
                            VButton(label: "Save", style: .primary) {
                                store.saveTwitterLocalClient(
                                    clientId: twitterClientId,
                                    clientSecret: twitterClientSecret.isEmpty ? nil : twitterClientSecret
                                )
                                twitterClientId = ""
                                twitterClientSecret = ""
                            }
                            .disabled(twitterClientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                } else {
                    // Client configured — show connect or connected state
                    if store.twitterConnected {
                        // Connected state
                        HStack(spacing: VSpacing.sm) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundColor(VColor.success)
                                .font(.system(size: 14))
                            Text("Connected")
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            if let account = store.twitterAccountInfo {
                                Text(account)
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textMuted)
                            }
                            Spacer()
                            VButton(label: "Disconnect", style: .danger) {
                                store.disconnectTwitter()
                            }
                        }
                    } else {
                        // Client configured but not connected
                        HStack(spacing: VSpacing.sm) {
                            Image(systemName: "circle")
                                .foregroundColor(VColor.textMuted)
                                .font(.system(size: 14))
                            Text("App configured")
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Spacer()
                            if store.twitterAuthInProgress {
                                ProgressView()
                                    .controlSize(.small)
                                Text("Connecting...")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textSecondary)
                            } else {
                                VButton(label: "Connect", style: .primary) {
                                    store.connectTwitter()
                                }
                            }
                        }
                    }

                    if let error = store.twitterAuthError {
                        Text(error)
                            .font(VFont.caption)
                            .foregroundColor(VColor.error)
                    }

                    // Clear/reconfigure button
                    HStack {
                        Spacer()
                        Button("Clear App Config") {
                            store.clearTwitterLocalClient()
                            twitterClientId = ""
                            twitterClientSecret = ""
                        }
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    }
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Telegram Section

    private var telegramSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Telegram")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            if store.telegramHasBotToken {
                // Connected / configured state
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                        .font(.system(size: 14))
                    if let username = store.telegramBotUsername {
                        Text("@\(username)")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                    } else {
                        Text("Bot token configured")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                    }
                    Spacer()
                    VButton(label: "Clear", style: .danger) {
                        store.clearTelegramCredentials()
                        telegramBotTokenText = ""
                    }
                }
            } else {
                // Not configured — show SecureField for token entry
                HStack(spacing: VSpacing.xs) {
                    Text("Enter Bot Token")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }

                SecureField("Telegram bot token", text: $telegramBotTokenText)
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

                Text("Get your bot token from @BotFather on Telegram")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)

                if store.telegramSaveInProgress {
                    HStack(spacing: VSpacing.sm) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Saving...")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                    }
                } else {
                    VButton(label: "Save", style: .primary) {
                        store.saveTelegramToken(botToken: telegramBotTokenText)
                        telegramBotTokenText = ""
                    }
                    .disabled(telegramBotTokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }

            if let error = store.telegramError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Twilio Section

    private var twilioSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("SMS (Twilio)")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            if store.twilioHasCredentials {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                        .font(.system(size: 14))
                    Text("Credentials configured")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Spacer()
                    if store.twilioSaveInProgress {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        VButton(label: "Clear Credentials", style: .danger) {
                            store.clearTwilioCredentials()
                        }
                    }
                }
            } else {
                HStack(spacing: VSpacing.xs) {
                    Text("Enter Account SID and Auth Token")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }

                TextField("Account SID", text: $twilioAccountSidText)
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

                SecureField("Auth Token", text: $twilioAuthTokenText)
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

                if store.twilioSaveInProgress {
                    HStack(spacing: VSpacing.sm) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Saving...")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                    }
                } else {
                    VButton(label: "Save Credentials", style: .primary) {
                        store.saveTwilioCredentials(
                            accountSid: twilioAccountSidText,
                            authToken: twilioAuthTokenText
                        )
                        twilioAuthTokenText = ""
                    }
                    .disabled(
                        twilioAccountSidText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        twilioAuthTokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                }
            }

            Divider()
                .background(VColor.surfaceBorder)

            HStack {
                Text("Assigned Number")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                Spacer()
                Text(store.twilioPhoneNumber ?? "Not assigned")
                    .font(VFont.mono)
                    .foregroundColor(store.twilioPhoneNumber == nil ? VColor.textMuted : VColor.textPrimary)
            }

            HStack(spacing: VSpacing.sm) {
                TextField("Assign existing (+1555...)", text: $twilioPhoneNumberText)
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

                VButton(label: "Assign", style: .secondary) {
                    store.assignTwilioNumber(phoneNumber: twilioPhoneNumberText)
                    twilioPhoneNumberText = ""
                }
                .disabled(
                    twilioPhoneNumberText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                    store.twilioSaveInProgress
                )
            }

            HStack(spacing: VSpacing.sm) {
                TextField("Area code (optional)", text: $twilioAreaCodeText)
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

                TextField("Country", text: $twilioCountryText)
                    .textFieldStyle(.plain)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .padding(VSpacing.md)
                    .frame(width: 90)
                    .background(VColor.surface)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                    )

                VButton(label: "Provision", style: .secondary) {
                    store.provisionTwilioNumber(
                        areaCode: twilioAreaCodeText,
                        country: twilioCountryText
                    )
                }
                .disabled(store.twilioSaveInProgress)
            }

            HStack(spacing: VSpacing.sm) {
                if store.twilioListInProgress {
                    ProgressView()
                        .controlSize(.small)
                }
                VButton(label: "Refresh Numbers", style: .tertiary) {
                    store.refreshTwilioNumbers()
                }
                .disabled(store.twilioListInProgress)
            }

            if !store.twilioNumbers.isEmpty {
                ForEach(store.twilioNumbers, id: \.phoneNumber) { number in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(number.phoneNumber)
                                .font(VFont.mono)
                                .foregroundColor(VColor.textPrimary)
                            Text(number.friendlyName)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        Spacer()
                        VButton(label: "Use", style: .secondary) {
                            store.assignTwilioNumber(phoneNumber: number.phoneNumber)
                        }
                        .disabled(store.twilioSaveInProgress)
                    }
                }
            }

            if let warning = store.twilioWarning {
                Text(warning)
                    .font(VFont.caption)
                    .foregroundColor(VColor.warning)
            }

            if let error = store.twilioError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Trust Tab

    private var trustContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            // PERMISSIONS section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Permissions")
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

            // TRUST RULES section
            if daemonClient != nil {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Trust Rules")
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
                        VButton(label: "Manage...", style: .tertiary) {
                            daemonClient?.isTrustRulesSheetOpen = true
                            showingTrustRules = true
                        }
                        .disabled(store.isAnyTrustRulesSheetOpen)
                    }
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)
            }

            // PERMISSION SIMULATOR section
            if let model = testerModel {
                ToolPermissionTesterView(model: model)
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
        }
    }

    // MARK: - Reminders Tab

    private var remindersContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            if daemonClient != nil {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Reminders")
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
                        VButton(label: "Manage...", style: .tertiary) {
                            showingReminders = true
                        }
                    }
                }
                .padding(VSpacing.lg)
                .vCard(background: VColor.surfaceSubtle)
            }
        }
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

    // MARK: - Gateway Health Check

    private func checkGatewayHealth() {
        gatewayHealthResult = nil
        checkingGateway = true

        Task {
            defer { checkingGateway = false }

            guard let url = URL(string: "\(store.localGatewayTarget)/healthz") else {
                withAnimation(VAnimation.fast) { gatewayHealthResult = false }
                return
            }

            var request = URLRequest(url: url)
            request.timeoutInterval = 3

            let reachable: Bool
            do {
                let (_, response) = try await URLSession.shared.data(for: request)
                if let httpResponse = response as? HTTPURLResponse {
                    reachable = (200..<300).contains(httpResponse.statusCode)
                } else {
                    reachable = false
                }
            } catch {
                reachable = false
            }

            withAnimation(VAnimation.fast) { gatewayHealthResult = reachable }

            // Auto-dismiss the status message after 4 seconds
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            withAnimation(VAnimation.fast) { gatewayHealthResult = nil }
        }
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

// MARK: - Settings Nav Row

private struct SettingsNavRow: View {
    let tab: SettingsTab
    let isSelected: Bool
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text(tab.rawValue)
                .font(isSelected ? VFont.bodyMedium : VFont.body)
                .foregroundColor(isSelected ? VColor.textPrimary : VColor.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .background(isSelected ? VColor.hoverOverlay.opacity(0.08) : (isHovered ? VColor.hoverOverlay.opacity(0.04) : Color.clear))
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
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
struct SettingsPanelEnvVarsSheet: View {
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
                VButton(label: "Done", style: .tertiary) { dismiss() }
            }
            .padding(VSpacing.lg)

            Divider().background(VColor.surfaceBorder)

            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    envVarsSection(title: "App Process", vars: appEnvVars)
                    envVarsSection(title: "Daemon Process", vars: daemonEnvVars)
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
