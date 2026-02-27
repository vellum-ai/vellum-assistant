import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

// MARK: - Parental Control Settings Tab

/// Settings tab for configuring parental controls: PIN lock, content topic
/// restrictions, and tool category blocks.
@MainActor
struct SettingsParentalTab: View {
    var daemonClient: DaemonClient?
    @ObservedObject var settingsStore: SettingsStore

    // -- Remote state (loaded from daemon) --
    @State private var isEnabled: Bool = false
    @State private var hasPIN: Bool = false
    @State private var contentRestrictions: Set<String> = []
    @State private var blockedToolCategories: Set<String> = []
    @State private var allowedApps: [String] = []
    @State private var allowedWidgets: [String] = []

    // -- Local UI state --
    @State private var isLoading: Bool = false
    @State private var errorMessage: String?
    @State private var successMessage: String?
    @State private var showSuccessToast: Bool = false

    // -- PIN sheet --
    @State private var showingPINSheet: Bool = false
    @State private var pinSheetMode: PINSheetMode = .set

    // -- Set-PIN-to-enable sheet (shown when enabling parental controls without an existing PIN) --
    @State private var showingSetPINForEnableSheet: Bool = false
    @State private var showingDisableConfirmation: Bool = false


    // -- Child: request permission sheet --
    @State private var showingRequestPermissionSheet: Bool = false
    @State private var requestToolName: String = ""
    @State private var requestReason: String = ""
    @State private var requestSent: Bool = false

    // -- Parent: pending approvals --
    @State private var pendingRequests: [ApprovalRequestItem] = []
    /// Timer that auto-refreshes the pending-approvals list every 15 seconds when the
    /// parental profile is active, so newly submitted child requests appear promptly.
    private let approvalRefreshTimer = Timer.publish(every: 15, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            // Header + enable toggle + PIN lock (merged into one card)
            enableSection

            if isEnabled {
                if settingsStore.activeProfile == "child" {
                    // Child-side: allow the child to request permission for a blocked tool
                    requestPermissionSection
                }

                if settingsStore.activeProfile == "parental" {
                    // Parent-side: review and respond to pending permission requests
                    pendingApprovalsSection
                }

                contentRestrictionsSection
                toolCategorySection
                // Allowlist and activity log are only visible to the parent
                if settingsStore.activeProfile == "parental" {
                    appsAndWidgetsSection
                    integrationsSection
                    activityLogSection
                }
            }
        }
        .overlay(alignment: .bottom) {
            if showSuccessToast, let msg = successMessage {
                VToast(message: msg, style: .success)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.bottom, VSpacing.md)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .onAppear {
                        Task {
                            try? await Task.sleep(for: .seconds(3))
                            withAnimation(VAnimation.standard) {
                                showSuccessToast = false
                                successMessage = nil
                            }
                        }
                    }
            }
        }
        .animation(VAnimation.standard, value: showSuccessToast)
        .alert("Disable Parental Controls?", isPresented: $showingDisableConfirmation) {
            Button("Cancel", role: .cancel) { }
            Button("Disable", role: .destructive) {
                updateEnabled(false)
            }
        } message: {
            Text("This will remove all restrictions. Are you sure?")
        }
        .onAppear {
            loadSettings()
            settingsStore.loadActivityLog()
            settingsStore.loadAllowedIntegrations(pin: settingsStore.cachedPIN ?? "")
            // Load pending approvals immediately when the parental profile is active.
            if settingsStore.activeProfile == "parental" && isEnabled {
                loadPendingApprovals()
            }
        }
        .onReceive(approvalRefreshTimer) { _ in
            // Silently refresh the pending-approvals list in the background so the
            // parent sees new child requests without having to tap Refresh manually.
            if settingsStore.activeProfile == "parental" && isEnabled {
                loadPendingApprovals()
            }
        }
        .sheet(isPresented: $showingPINSheet) {
            PINSheet(
                mode: pinSheetMode,
                onComplete: { result in
                    showingPINSheet = false
                    switch result {
                    case .success(let mode):
                        // Delay the toast slightly so the sheet-dismiss animation
                        // finishes before successMessage is set. Without this delay,
                        // the sheet teardown can race with the onChange observer and
                        // the toast never appears.
                        Task {
                            try? await Task.sleep(for: .milliseconds(350))
                            switch mode {
                            case .set:
                                hasPIN = true
                                successMessage = "PIN set."
                                showSuccessToast = true
                            case .change:
                                // The old PIN is now invalid; clear the cache so subsequent
                                // updates don't silently send a stale credential.
                                settingsStore.cachedPIN = nil
                                successMessage = "PIN changed."
                                showSuccessToast = true
                            case .clear:
                                hasPIN = false
                                settingsStore.cachedPIN = nil
                                successMessage = "PIN cleared."
                                showSuccessToast = true
                            }
                        }
                    case .failure(let msg):
                        errorMessage = msg
                    }
                },
                daemonClient: daemonClient
            )
        }
        .sheet(isPresented: $showingRequestPermissionSheet) {
            RequestPermissionSheet(
                toolName: $requestToolName,
                reason: $requestReason,
                onSend: { sendPermissionRequest() },
                onDismiss: {
                    showingRequestPermissionSheet = false
                    requestToolName = ""
                    requestReason = ""
                    requestSent = false
                }
            )
        }
        .sheet(isPresented: $showingSetPINForEnableSheet) {
            SetPINForEnableSheet(
                onComplete: { result in
                    showingSetPINForEnableSheet = false
                    switch result {
                    case .success(let pin):
                        // PIN is now set; cache it and enable parental controls
                        settingsStore.cachedPIN = pin
                        hasPIN = true
                        updateEnabled(true)
                    case .failure(let msg):
                        errorMessage = msg
                    }
                },
                daemonClient: daemonClient
            )
        }
    }

    // MARK: - Sections

    private var enableSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Parental Controls")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            Text("Restrict the assistant's capabilities for child users. A PIN is required to change these settings.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            HStack {
                Text("Enable Parental Controls")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                if isLoading {
                    ProgressView()
                        .scaleEffect(0.6)
                        .padding(.leading, VSpacing.xs)
                }
                Spacer()
                Toggle("", isOn: Binding(
                    get: { isEnabled },
                    set: { newValue in
                        if newValue && !isEnabled && !hasPIN {
                            // Enabling without an existing PIN — require the user to create
                            // one first so parental controls are always PIN-protected.
                            showingSetPINForEnableSheet = true
                        } else if !newValue && isEnabled {
                            // Disabling requires confirmation to prevent accidental removal
                            // of all restrictions.
                            showingDisableConfirmation = true
                        } else {
                            updateEnabled(newValue)
                        }
                    }
                ))
                .toggleStyle(.switch)
                .labelsHidden()
                .accessibilityLabel("Enable Parental Controls")
                .disabled(isLoading)
            }

            if let error = errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .textSelection(.enabled)
            }

            if isEnabled {
                VColor.divider
                    .frame(height: 1)
                    .padding(.vertical, VSpacing.xs)

                Text("PIN Lock")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)

                Text(hasPIN
                    ? "A 6-digit PIN protects these settings."
                    : "Protect parental settings with a 6-digit PIN.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)

                HStack(spacing: VSpacing.sm) {
                    if hasPIN {
                        VButton(label: "Change PIN", style: .secondary) {
                            errorMessage = nil
                            successMessage = nil
                            pinSheetMode = .change
                            showingPINSheet = true
                        }
                        VButton(label: "Remove PIN", style: .danger) {
                            errorMessage = nil
                            successMessage = nil
                            pinSheetMode = .clear
                            showingPINSheet = true
                        }
                    } else {
                        VButton(label: "Set PIN", style: .primary) {
                            errorMessage = nil
                            successMessage = nil
                            pinSheetMode = .set
                            showingPINSheet = true
                        }
                    }
                    Spacer()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    private var contentRestrictionsSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text("Content Restrictions")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                smartToggleButton(
                    enabledCount: contentRestrictions.count,
                    totalCount: ContentTopic.allCases.count,
                    onEnable: { updateContentRestrictions(ContentTopic.allCases.map { $0.rawValue }) },
                    onDisable: { updateContentRestrictions([]) }
                )
            }

            Text("Block responses on specific topics in Restricted Mode.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .textSelection(.enabled)

            ForEach(ContentTopic.allCases) { topic in
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack {
                        Text(topic.displayName)
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        Toggle("", isOn: Binding(
                            get: { contentRestrictions.contains(topic.rawValue) },
                            set: { enabled in
                                var updated = contentRestrictions
                                if enabled { updated.insert(topic.rawValue) } else { updated.remove(topic.rawValue) }
                                updateContentRestrictions(Array(updated))
                            }
                        ))
                        .toggleStyle(.switch)
                        .labelsHidden()
                        .accessibilityLabel(topic.displayName)
                        .disabled(isLoading)
                    }
                    Text(topic.description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    private var toolCategorySection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text("Tool Restrictions")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                smartToggleButton(
                    enabledCount: blockedToolCategories.count,
                    totalCount: ToolCategory.allCases.count,
                    onEnable: { updateToolCategories(ToolCategory.allCases.map { $0.rawValue }) },
                    onDisable: { updateToolCategories([]) }
                )
            }

            Text("Prevent certain tool categories from being used in Restricted Mode.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .textSelection(.enabled)

            ForEach(ToolCategory.allCases) { category in
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack {
                        Text(category.displayName)
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        Toggle("", isOn: Binding(
                            get: { blockedToolCategories.contains(category.rawValue) },
                            set: { blocked in
                                var updated = blockedToolCategories
                                if blocked { updated.insert(category.rawValue) } else { updated.remove(category.rawValue) }
                                updateToolCategories(Array(updated))
                            }
                        ))
                        .toggleStyle(.switch)
                        .labelsHidden()
                        .accessibilityLabel(category.displayName)
                        .disabled(isLoading)
                    }
                    Text(category.description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Apps Section

    private var appsAndWidgetsSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text("Apps")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                smartToggleButton(
                    enabledCount: allowedApps.count,
                    totalCount: AppListManager.shared.apps.count,
                    onEnable: {
                        let allIds = AppListManager.shared.apps.map { $0.id }
                        allowedApps = allIds
                        updateAllowlist(apps: allIds, widgets: nil)
                    },
                    onDisable: {
                        allowedApps = []
                        updateAllowlist(apps: [], widgets: nil)
                    }
                )
            }

            Text("Choose which apps are accessible in Restricted Mode.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            let knownApps = AppListManager.shared.apps
            if knownApps.isEmpty {
                Text("No apps tracked yet — apps will appear here as they are used.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .textSelection(.enabled)
            } else {
                ForEach(knownApps) { app in
                    HStack(spacing: VSpacing.sm) {
                        if let symbol = app.sfSymbol {
                            let gradientColors: [String] = app.iconBackground ?? ["#7C3AED", "#4F46E5"]
                            VAppIcon(sfSymbol: symbol, gradientColors: gradientColors, size: .small)
                                .scaleEffect(0.5)
                                .frame(width: 16, height: 16)
                        }
                        Text(app.name)
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                        Spacer()
                        Toggle("", isOn: Binding(
                            get: { allowedApps.contains(app.id) },
                            set: { enabled in
                                if enabled { allowedApps.append(app.id) }
                                else { allowedApps.removeAll { $0 == app.id } }
                                updateAllowlist(apps: allowedApps, widgets: nil)
                            }
                        ))
                        .toggleStyle(.switch)
                        .labelsHidden()
                        .accessibilityLabel("\(app.name) allowed")
                        .disabled(isLoading)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Integrations Section

    /// A configured integration entry for display in the parental controls tab.
    private struct ConfiguredIntegration {
        let id: String
        let label: String
        let subtitle: String
        let icon: String
        let iconColor: Color
    }

    /// Build the list of integrations that are currently configured in the Integrations tab.
    private var configuredIntegrations: [ConfiguredIntegration] {
        var result: [ConfiguredIntegration] = []
        if settingsStore.hasPerplexityKey {
            result.append(ConfiguredIntegration(
                id: "perplexity",
                label: "Perplexity Search",
                subtitle: "AI-powered web search",
                icon: "magnifyingglass",
                iconColor: .orange
            ))
        }
        if settingsStore.hasBraveKey {
            result.append(ConfiguredIntegration(
                id: "brave",
                label: "Brave Search",
                subtitle: "Private web search",
                icon: "magnifyingglass.circle.fill",
                iconColor: Color(red: 0.97, green: 0.42, blue: 0.13)
            ))
        }
        if settingsStore.hasImageGenKey {
            result.append(ConfiguredIntegration(
                id: "image_gen",
                label: "Image Generation",
                subtitle: "Generate images with Gemini",
                icon: "photo.fill",
                iconColor: .purple
            ))
        }
        if settingsStore.hasElevenLabsKey {
            result.append(ConfiguredIntegration(
                id: "elevenlabs",
                label: "Voice (ElevenLabs)",
                subtitle: "Text-to-speech voice output",
                icon: "waveform",
                iconColor: .blue
            ))
        }
        if settingsStore.twitterConnected {
            result.append(ConfiguredIntegration(
                id: "twitter",
                label: "Twitter / X",
                subtitle: "Post and read tweets",
                icon: "bird.fill",
                iconColor: .primary
            ))
        }
        return result
    }

    private var integrationsSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text("Integrations")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                let integrations = configuredIntegrations
                if !integrations.isEmpty {
                    let allowedCount = settingsStore.allowedIntegrations
                        .filter { integrations.map { $0.id }.contains($0) }.count
                    smartToggleButton(
                        enabledCount: allowedCount,
                        totalCount: integrations.count,
                        onEnable: {
                            let pin = settingsStore.cachedPIN ?? ""
                            let allIds = integrations.map { $0.id }
                            settingsStore.allowedIntegrations = allIds
                            settingsStore.updateAllowedIntegrations(pin: pin, integrations: allIds)
                        },
                        onDisable: {
                            let pin = settingsStore.cachedPIN ?? ""
                            settingsStore.allowedIntegrations = []
                            settingsStore.updateAllowedIntegrations(pin: pin, integrations: [])
                        }
                    )
                }
            }

            Text("Choose which integrations are accessible in Restricted Mode.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            let integrations = configuredIntegrations
            if integrations.isEmpty {
                Text("No integrations configured. Set up integrations in the Integrations tab.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .textSelection(.enabled)
            } else {
                ForEach(integrations, id: \.id) { integration in
                    HStack(spacing: VSpacing.sm) {
                        ZStack {
                            RoundedRectangle(cornerRadius: VRadius.xs)
                                .fill(integration.iconColor)
                                .frame(width: 14, height: 14)
                            Image(systemName: integration.icon)
                                .font(.system(size: 7, weight: .medium))
                                .foregroundColor(.white)
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(integration.label)
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.textPrimary)
                            Text(integration.subtitle)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textSecondary)
                        }
                        Spacer()
                        Toggle("", isOn: Binding(
                            get: { settingsStore.allowedIntegrations.contains(integration.id) },
                            set: { isOn in
                                let pin = settingsStore.cachedPIN ?? ""
                                let updated = isOn
                                    ? settingsStore.allowedIntegrations + [integration.id]
                                    : settingsStore.allowedIntegrations.filter { $0 != integration.id }
                                settingsStore.allowedIntegrations = updated
                                settingsStore.updateAllowedIntegrations(pin: pin, integrations: updated)
                            }
                        ))
                        .toggleStyle(.switch)
                        .labelsHidden()
                        .accessibilityLabel(integration.label)
                        .disabled(isLoading)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Activity Log Section

    private var activityLogSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text("Activity Log")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                VButton(label: "Export", leftIcon: "square.and.arrow.up", style: .tertiary, size: .small) {
                    exportActivityLog()
                }
                .disabled(settingsStore.activityLog.isEmpty)
                VButton(label: "Clear Log", leftIcon: "trash", style: .danger, size: .small) {
                    settingsStore.clearActivityLogEntries(pin: settingsStore.cachedPIN)
                }
                .accessibilityLabel("Clear activity log")
                .disabled(settingsStore.activityLog.isEmpty)
            }

            Text("Actions taken during Restricted Mode sessions.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            if settingsStore.activityLog.isEmpty {
                Text("No activity recorded yet.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .textSelection(.enabled)
            } else {
                ForEach(settingsStore.activityLog.reversed()) { entry in
                    ActivityLogEntryRow(entry: entry)
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Request Permission Section (child profile)

    private var requestPermissionSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Request Permission")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            Text("Ask your parent to approve a blocked action.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            VButton(label: "Request Parent Permission", style: .secondary) {
                requestToolName = ""
                requestReason = ""
                requestSent = false
                showingRequestPermissionSheet = true
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    private func sendPermissionRequest() {
        let toolName = requestToolName.trimmingCharacters(in: .whitespacesAndNewlines)
        let reason = requestReason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !toolName.isEmpty else { return }

        let stream = daemonClient?.subscribe()
        Task {
            do {
                try daemonClient?.sendParentalControlApprovalCreate(toolName: toolName, reason: reason)
            } catch {
                await MainActor.run {
                    showingRequestPermissionSheet = false
                }
                return
            }

            let _: ParentalControlApprovalCreateResponseMessage? = await withTaskGroup(of: ParentalControlApprovalCreateResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlApprovalCreateResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                requestSent = true
                showingRequestPermissionSheet = false
            }
        }
    }

    // MARK: - Pending Approvals Section (parental profile)

    private var pendingApprovalsSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text("Pending Approvals")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                VIconButton(label: "Refresh pending approvals", icon: "arrow.clockwise", iconOnly: true) {
                    loadPendingApprovals()
                }
                .accessibilityLabel("Refresh pending approvals")
            }

            Text("Review and approve permission requests from Restricted Mode.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            let pending = pendingRequests.filter { $0.status == "pending" }
            if pending.isEmpty {
                Text("No pending requests.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .padding(.top, VSpacing.xs)
            } else {
                ForEach(pending) { request in
                    approvalRequestRow(request)
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
    }

    private func approvalRequestRow(_ request: ApprovalRequestItem) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(request.toolName)
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.textPrimary)
            Text(request.reason)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            HStack(spacing: VSpacing.sm) {
                VButton(label: "Approve Always", style: .primary) {
                    respondToRequest(request, decision: "approve_always")
                }
                VButton(label: "Approve Once", style: .secondary) {
                    respondToRequest(request, decision: "approve_once")
                }
                VButton(label: "Reject", style: .danger) {
                    respondToRequest(request, decision: "reject")
                }
            }
        }
        .padding(.top, VSpacing.xs)
    }

    private func loadPendingApprovals() {
        let stream = daemonClient?.subscribe()
        let pin = settingsStore.cachedPIN
        Task {
            do {
                try daemonClient?.sendParentalControlApprovalList(pin: pin)
            } catch {
                return
            }

            let response: ParentalControlApprovalListResponseMessage? = await withTaskGroup(of: ParentalControlApprovalListResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlApprovalListResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                if let r = response {
                    pendingRequests = r.requests.map { item in
                        ApprovalRequestItem(
                            id: item.id,
                            toolName: item.toolName,
                            reason: item.reason,
                            status: item.status,
                            createdAt: item.createdAt,
                            resolvedAt: item.resolvedAt
                        )
                    }
                }
            }
        }
    }

    private func respondToRequest(_ request: ApprovalRequestItem, decision: String) {
        let stream = daemonClient?.subscribe()
        let pin = settingsStore.cachedPIN
        Task {
            do {
                try daemonClient?.sendParentalControlApprovalRespond(
                    requestId: request.id,
                    decision: decision,
                    pin: pin
                )
            } catch {
                return
            }

            let _: ParentalControlApprovalRespondResponseMessage? = await withTaskGroup(of: ParentalControlApprovalRespondResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlApprovalRespondResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                // Refresh the list after responding
                loadPendingApprovals()
            }
        }
    }

    // MARK: - Daemon interactions

    private func loadSettings() {
        errorMessage = nil

        guard daemonClient != nil else { return }
        isLoading = true
        let stream = daemonClient?.subscribe()
        Task {
            do {
                try daemonClient?.sendParentalControlGet()
            } catch {
                await MainActor.run {
                    isLoading = false
                    errorMessage = "Failed to load settings: \(error.localizedDescription)"
                }
                return
            }

            // Wait for the response (with timeout)
            let response: ParentalControlGetResponseMessage? = await withTaskGroup(of: ParentalControlGetResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlGetResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                isLoading = false
                if let r = response {
                    isEnabled = r.enabled
                    settingsStore.isParentalEnabled = r.enabled
                    hasPIN = r.has_pin
                    contentRestrictions = Set(r.content_restrictions)
                    blockedToolCategories = Set(r.blocked_tool_categories)
                    // Also load pending approvals when on the parental profile
                    if settingsStore.activeProfile == "parental" {
                        loadPendingApprovals()
                    }
                } else {
                    errorMessage = "No response from daemon."
                }
            }

            // Also fetch the allowlist
            loadAllowlist()
        }
    }

    private func loadAllowlist() {
        let stream = daemonClient?.subscribe()
        Task {
            do {
                try daemonClient?.sendParentalControlAllowlistGet()
            } catch {
                return
            }

            let response: ParentalControlAllowlistGetResponseMessage? = await withTaskGroup(of: ParentalControlAllowlistGetResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlAllowlistGetResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                if let r = response {
                    allowedApps = r.allowedApps
                    allowedWidgets = r.allowedWidgets
                    settingsStore.allowedApps = r.allowedApps
                    settingsStore.allowedWidgets = r.allowedWidgets
                    // Load time limits now that we have the allowlist. Pass an
                    // empty string when no PIN is configured — the daemon skips
                    // PIN verification in that case.
                    settingsStore.loadAppTimeLimits(pin: settingsStore.cachedPIN ?? "")
                }
            }
        }
    }

    private func updateAllowlist(apps: [String]?, widgets: [String]?) {
        // Optimistic update so toggles respond immediately even if daemon is unavailable.
        if let apps = apps { allowedApps = apps; settingsStore.allowedApps = apps }
        if let widgets = widgets { allowedWidgets = widgets; settingsStore.allowedWidgets = widgets }
        errorMessage = nil
        successMessage = nil

        guard daemonClient != nil else { return }
        let stream = daemonClient?.subscribe()
        let pin = settingsStore.cachedPIN
        Task {
            do {
                try daemonClient?.sendParentalControlAllowlistUpdate(
                    pin: pin,
                    allowedApps: apps,
                    allowedWidgets: widgets
                )
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    loadAllowlist()
                }
                return
            }

            let response: ParentalControlAllowlistUpdateResponseMessage? = await withTaskGroup(of: ParentalControlAllowlistUpdateResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlAllowlistUpdateResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                if let r = response, r.success {
                    allowedApps = r.allowedApps
                    allowedWidgets = r.allowedWidgets
                    settingsStore.allowedApps = r.allowedApps
                    settingsStore.allowedWidgets = r.allowedWidgets
                } else {
                    errorMessage = response?.error ?? "Update failed."
                    loadAllowlist()
                }
            }
        }
    }

    private func exportActivityLog() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType.commaSeparatedText]
        panel.nameFieldStringValue = "activity-log.csv"
        if panel.runModal() == .OK, let url = panel.url {
            let header = "Timestamp,Type,Description\n"
            let rows = settingsStore.activityLog.map {
                "\($0.timestamp),\($0.actionType),\"\($0.description)\""
            }.joined(separator: "\n")
            try? (header + rows).write(to: url, atomically: true, encoding: .utf8)
        }
    }

    private func updateEnabled(_ enabled: Bool) {
        isLoading = true
        errorMessage = nil
        successMessage = nil

        let stream = daemonClient?.subscribe()
        let pin = settingsStore.cachedPIN
        Task {
            do {
                try daemonClient?.sendParentalControlUpdate(pin: pin, enabled: enabled)
            } catch {
                await MainActor.run {
                    isLoading = false
                    errorMessage = error.localizedDescription
                }
                return
            }

            let response: ParentalControlUpdateResponseMessage? = await withTaskGroup(of: ParentalControlUpdateResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlUpdateResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                isLoading = false
                if let r = response {
                    if r.success {
                        isEnabled = r.enabled
                        settingsStore.isParentalEnabled = r.enabled
                        hasPIN = r.has_pin
                        contentRestrictions = Set(r.content_restrictions)
                        blockedToolCategories = Set(r.blocked_tool_categories)
                    } else {
                        errorMessage = r.error ?? "Update failed."
                    }
                } else {
                    errorMessage = "No response from daemon."
                }
            }
        }
    }

    private func updateContentRestrictions(_ restrictions: [String]) {
        // Optimistic update so toggles respond immediately even if daemon is unavailable.
        contentRestrictions = Set(restrictions)
        errorMessage = nil
        successMessage = nil

        guard daemonClient != nil else { return }
        let stream = daemonClient?.subscribe()
        let pin = settingsStore.cachedPIN
        Task {
            do {
                try daemonClient?.sendParentalControlUpdate(pin: pin, contentRestrictions: restrictions)
            } catch {
                await MainActor.run { errorMessage = error.localizedDescription }
                return
            }

            let response: ParentalControlUpdateResponseMessage? = await withTaskGroup(of: ParentalControlUpdateResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlUpdateResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                if let r = response, r.success {
                    contentRestrictions = Set(r.content_restrictions)
                } else {
                    errorMessage = response?.error ?? "Update failed."
                    loadSettings()
                }
            }
        }
    }

    private func updateToolCategories(_ categories: [String]) {
        // Optimistic update so toggles respond immediately even if daemon is unavailable.
        blockedToolCategories = Set(categories)
        errorMessage = nil
        successMessage = nil

        guard daemonClient != nil else { return }
        let stream = daemonClient?.subscribe()
        let pin = settingsStore.cachedPIN
        Task {
            do {
                try daemonClient?.sendParentalControlUpdate(pin: pin, blockedToolCategories: categories)
            } catch {
                await MainActor.run { errorMessage = error.localizedDescription }
                return
            }

            let response: ParentalControlUpdateResponseMessage? = await withTaskGroup(of: ParentalControlUpdateResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlUpdateResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                if let r = response, r.success {
                    blockedToolCategories = Set(r.blocked_tool_categories)
                } else {
                    errorMessage = response?.error ?? "Update failed."
                    loadSettings()
                }
            }
        }
    }
}

// MARK: - Smart Enable/Disable All Button

extension SettingsParentalTab {
    /// A single smart button that adapts its label and style based on how many
    /// items are currently enabled relative to the total.
    ///
    /// - All enabled  → tertiary "Disable All"
    /// - All disabled → primary  "Enable All"
    /// - Partial      → secondary "Enable All"
    @ViewBuilder
    func smartToggleButton(
        enabledCount: Int,
        totalCount: Int,
        onEnable: @escaping () -> Void,
        onDisable: @escaping () -> Void
    ) -> some View {
        if totalCount == 0 {
            EmptyView()
        } else if enabledCount >= totalCount {
            VButton(label: "Disable All", style: .tertiary, size: .small) {
                onDisable()
            }
            .disabled(isLoading)
        } else if enabledCount == 0 {
            VButton(label: "Enable All", style: .primary, size: .small) {
                onEnable()
            }
            .disabled(isLoading)
        } else {
            VButton(label: "Enable All", style: .secondary, size: .small) {
                onEnable()
            }
            .disabled(isLoading)
        }
    }
}

// MARK: - PIN Sheet

private enum PINSheetMode {
    case set, change, clear
}

private enum PINSheetResult {
    case success(PINSheetMode)
    case failure(String)
}

@MainActor
private struct PINSheet: View {
    let mode: PINSheetMode
    let onComplete: (PINSheetResult) -> Void
    var daemonClient: DaemonClient?

    private enum Step: Hashable {
        case enterCurrent, enterNew, confirmNew
    }

    @State private var step: Step = .enterCurrent
    /// The single active input field — reset to "" on every step transition so
    /// `.id(step)` always recreates `PINCircleField` with a clean, focused field.
    @State private var pinInput: String = ""
    /// Captured after the user leaves `.enterCurrent`. Passed to the IPC call.
    @State private var storedCurrent: String = ""
    /// Captured after the user leaves `.enterNew`. Compared against in `.confirmNew`.
    @State private var storedNew: String = ""
    @State private var isLoading: Bool = false
    @State private var errorMessage: String?
    /// Incrementing this triggers PINCircleField to re-grab keyboard focus
    /// without a step transition (i.e. after an inline error on the same step).
    @State private var pinFocusTrigger: Int = 0

    @Environment(\.dismiss) private var dismiss

    private var title: String {
        switch mode {
        case .set: return "Set Passcode"
        case .change: return "Change Passcode"
        case .clear: return "Remove Passcode"
        }
    }

    private var stepSubtitle: String {
        switch step {
        case .enterCurrent:
            return mode == .clear ? "Enter your current passcode to confirm removal." : "Enter your current passcode."
        case .enterNew:
            return "Enter your new passcode."
        case .confirmNew:
            return "Re-enter your new passcode."
        }
    }

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            // Header
            VStack(spacing: VSpacing.xs) {
                Text(title)
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)
                Text(stepSubtitle)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .center)

            // Single input field — `.id(step)` tears it down and rebuilds it
            // (triggering auto-focus) whenever the step changes. `pinInput` is
            // always reset to "" before the step is changed, so a stale
            // onChange callback from the previous step can never fire advance().
            PINCircleField(text: $pinInput, focusTrigger: pinFocusTrigger)
                .frame(maxWidth: .infinity, alignment: .center)
                .id(step)
                .onChange(of: pinInput) { _, v in
                    if v.count == 6 { advance() }
                }

            // Error / placeholder to keep height stable
            if let error = errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .multilineTextAlignment(.center)
            } else {
                Text(" ").font(VFont.caption)
            }

            // Footer
            if isLoading {
                ProgressView().scaleEffect(0.8)
            } else {
                VButton(label: "Cancel", style: .secondary) { dismiss() }
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 320)
        .fixedSize(horizontal: false, vertical: true)
        .background(VColor.background)
        .onAppear {
            // Always reset to the correct starting step for the given mode.
            // This handles re-presentation of the sheet after a previous session.
            if mode == .set {
                step = .enterNew
            } else {
                step = .enterCurrent
            }
            pinInput = ""
            storedCurrent = ""
            storedNew = ""
            errorMessage = nil
            isLoading = false
        }
    }

    private func advance() {
        // Double-fire guard: `isLoading` covers the submit path; the `.count == 6`
        // check below covers step-transition paths (isLoading is never set there).
        guard !isLoading else { return }
        guard pinInput.count == 6 else { return }
        errorMessage = nil
        switch mode {
        case .set:
            if step == .enterNew {
                storedNew = pinInput
                pinInput = ""
                withAnimation(VAnimation.standard) { step = .confirmNew }
            } else if step == .confirmNew {
                if pinInput == storedNew { submit() }
                else { mismatch() }
            }
        case .change:
            if step == .enterCurrent {
                // Verify the current PIN against the daemon before allowing
                // the user to enter a new PIN. This prevents anyone who does
                // not know the current PIN from changing it.
                verifyCurrentPIN()
            } else if step == .enterNew {
                storedNew = pinInput
                pinInput = ""
                withAnimation(VAnimation.standard) { step = .confirmNew }
            } else if step == .confirmNew {
                if pinInput == storedNew { submit() }
                else { mismatch() }
            }
        case .clear:
            storedCurrent = pinInput
            submit()
        }
    }

    private func mismatch() {
        errorMessage = "Passcodes don't match. Try again."
        storedNew = ""
        pinInput = ""
        withAnimation(VAnimation.standard) { step = .enterNew }
    }

    /// Verifies the current PIN against the daemon before allowing the user to
    /// proceed to the new-PIN entry step in the `.change` flow. On failure the
    /// field is cleared and an error message is shown so the user can retry.
    private func verifyCurrentPIN() {
        guard !isLoading else { return }
        let pinToVerify = pinInput
        isLoading = true
        errorMessage = nil
        let stream = daemonClient?.subscribe()
        Task {
            do {
                try daemonClient?.sendParentalControlVerifyPin(pin: pinToVerify)
            } catch {
                await MainActor.run {
                    isLoading = false
                    errorMessage = error.localizedDescription
                    pinInput = ""
                }
                return
            }

            let response: ParentalControlVerifyPinResponseMessage? = await withTaskGroup(
                of: ParentalControlVerifyPinResponseMessage?.self
            ) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlVerifyPinResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                isLoading = false
                if let r = response {
                    if r.verified {
                        storedCurrent = pinToVerify
                        pinInput = ""
                        withAnimation(VAnimation.standard) { step = .enterNew }
                    } else {
                        errorMessage = "Incorrect passcode. Try again."
                        pinInput = ""
                        pinFocusTrigger += 1
                    }
                } else {
                    errorMessage = "No response from daemon."
                    pinInput = ""
                    pinFocusTrigger += 1
                }
            }
        }
    }

    private func submit() {
        isLoading = true
        let stream = daemonClient?.subscribe()
        Task {
            do {
                switch mode {
                case .set:    try daemonClient?.sendParentalControlSetPin(newPin: storedNew)
                case .change: try daemonClient?.sendParentalControlChangePin(currentPin: storedCurrent, newPin: storedNew)
                case .clear:  try daemonClient?.sendParentalControlClearPin(currentPin: storedCurrent)
                }
            } catch {
                await MainActor.run {
                    isLoading = false
                    errorMessage = error.localizedDescription
                }
                return
            }

            let response: ParentalControlSetPinResponseMessage? = await withTaskGroup(of: ParentalControlSetPinResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlSetPinResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                isLoading = false
                if let r = response {
                    if r.success {
                        onComplete(.success(mode))
                    } else {
                        // Wrong passcode — restart from step 1
                        errorMessage = r.error ?? "Operation failed."
                        storedCurrent = ""
                        storedNew = ""
                        pinInput = ""
                        withAnimation(VAnimation.standard) {
                            step = (mode == .set) ? .enterNew : .enterCurrent
                        }
                    }
                } else {
                    errorMessage = "No response from daemon."
                }
            }
        }
    }
}

// MARK: - Set PIN for Enable Sheet

/// Result type for the set-PIN-to-enable flow.
private enum SetPINForEnableResult {
    case success(pin: String)
    case failure(String)
}

/// Sheet shown when the user tries to enable parental controls but has no PIN set.
/// The user must create a 6-digit PIN before parental controls can be activated.
@MainActor
private struct SetPINForEnableSheet: View {
    let onComplete: (SetPINForEnableResult) -> Void
    var daemonClient: DaemonClient?

    private enum Step: Hashable { case enterNew, confirmNew }

    @State private var step: Step = .enterNew
    @State private var pinInput: String = ""
    @State private var storedNew: String = ""
    @State private var isLoading: Bool = false
    @State private var errorMessage: String?

    @Environment(\.dismiss) private var dismiss

    private var stepSubtitle: String {
        step == .enterNew
            ? "Create a 6-digit passcode to protect parental settings."
            : "Re-enter your new passcode to confirm."
    }

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            VStack(spacing: VSpacing.xs) {
                Text("Set Parental Passcode")
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)
                Text(stepSubtitle)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .center)

            PINCircleField(text: $pinInput)
                .id(step)
                .onChange(of: pinInput) { _, v in
                    if v.count == 6 { advance() }
                }

            if let error = errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .multilineTextAlignment(.center)
            } else {
                Text(" ").font(VFont.caption)
            }

            if isLoading {
                ProgressView().scaleEffect(0.8)
            } else {
                VButton(label: "Cancel", style: .secondary) { dismiss() }
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 320)
        .background(VColor.background)
    }

    private func advance() {
        guard !isLoading else { return }
        guard pinInput.count == 6 else { return }
        errorMessage = nil
        if step == .enterNew {
            storedNew = pinInput
            pinInput = ""
            withAnimation(VAnimation.standard) { step = .confirmNew }
        } else {
            guard pinInput == storedNew else {
                errorMessage = "Passcodes don't match. Try again."
                storedNew = ""
                pinInput = ""
                withAnimation(VAnimation.standard) { step = .enterNew }
                return
            }
            submit()
        }
    }

    private func submit() {
        isLoading = true
        let stream = daemonClient?.subscribe()
        Task {
            do {
                try daemonClient?.sendParentalControlSetPin(newPin: storedNew)
            } catch {
                await MainActor.run {
                    isLoading = false
                    errorMessage = error.localizedDescription
                }
                return
            }

            let response: ParentalControlSetPinResponseMessage? = await withTaskGroup(of: ParentalControlSetPinResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlSetPinResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                isLoading = false
                if let r = response {
                    if r.success {
                        onComplete(.success(pin: storedNew))
                    } else {
                        errorMessage = r.error ?? "Failed to set passcode."
                        storedNew = ""
                        pinInput = ""
                        withAnimation(VAnimation.standard) { step = .enterNew }
                    }
                } else {
                    errorMessage = "No response from daemon."
                }
            }
        }
    }
}

// MARK: - Approval Request Model

/// Local model for a parental approval request received from the daemon.
struct ApprovalRequestItem: Identifiable {
    let id: String
    let toolName: String
    let reason: String
    let status: String
    let createdAt: String
    let resolvedAt: String?
}

// MARK: - Request Permission Sheet

/// Sheet presented to the child profile user to compose and send a permission request.
@MainActor
private struct RequestPermissionSheet: View {
    @Binding var toolName: String
    @Binding var reason: String
    let onSend: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("Request Parent Permission")
                .font(VFont.headline)
                .foregroundColor(VColor.textPrimary)

            Text("Describe the tool or action you'd like permission for, and explain why you need it.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            TextField("Tool / action name (e.g. bash, web search)", text: $toolName)
                .textFieldStyle(.roundedBorder)
                .font(VFont.body)

            TextField("Reason (e.g. need to run a homework script)", text: $reason)
                .textFieldStyle(.roundedBorder)
                .font(VFont.body)

            HStack {
                Spacer()
                VButton(label: "Cancel", style: .secondary) {
                    onDismiss()
                }
                VButton(label: "Send Request", style: .primary) {
                    onSend()
                }
                .disabled(toolName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 360)
        .background(VColor.background)
    }
}

// MARK: - Topic / Category enumerations

private enum ContentTopic: String, CaseIterable, Identifiable {
    case violence
    case adult_content
    case political
    case gambling
    case drugs

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .violence: return "Violence"
        case .adult_content: return "Adult Content"
        case .political: return "Political Topics"
        case .gambling: return "Gambling"
        case .drugs: return "Drugs & Controlled Substances"
        }
    }

    var description: String {
        switch self {
        case .violence: return "Violent or graphic content"
        case .adult_content: return "Explicit or mature content"
        case .political: return "Political topics and debates"
        case .gambling: return "Gambling and betting content"
        case .drugs: return "Drug-related content"
        }
    }
}

private enum ToolCategory: String, CaseIterable, Identifiable {
    case computer_use
    case network
    case shell
    case file_write

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .computer_use: return "Computer Control"
        case .network: return "Web & Network"
        case .shell: return "Terminal / Shell"
        case .file_write: return "File Editing"
        }
    }

    var description: String {
        switch self {
        case .computer_use: return "Screenshots, accessibility control, mouse & keyboard."
        case .network: return "Web search, web fetch, browser navigation."
        case .shell: return "Bash commands, terminal access."
        case .file_write: return "Creating, editing, or deleting files."
        }
    }
}

// MARK: - Activity Log Entry Row

/// A single row in the activity log list.
private struct ActivityLogEntryRow: View {
    let entry: ActivityLogEntry

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            HStack(alignment: .firstTextBaseline) {
                Text(actionTypeLabel)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                Text(formattedTimestamp)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .textSelection(.enabled)
            }
            Text(entry.description)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, VSpacing.xxs)
    }

    private var actionTypeLabel: String {
        switch entry.actionType {
        case "tool_call": return "Tool Call"
        case "request": return "Request"
        case "approval_request": return "Approval Request"
        default: return entry.actionType
        }
    }

    private var formattedTimestamp: String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: entry.timestamp) {
            let display = DateFormatter()
            display.dateStyle = .short
            display.timeStyle = .short
            return display.string(from: date)
        }
        // Fallback: try without fractional seconds
        let fallback = ISO8601DateFormatter()
        fallback.formatOptions = [.withInternetDateTime]
        if let date = fallback.date(from: entry.timestamp) {
            let display = DateFormatter()
            display.dateStyle = .short
            display.timeStyle = .short
            return display.string(from: date)
        }
        return entry.timestamp
    }
}

// MARK: - Preview

#Preview("Parental Tab") {
    ZStack {
        VColor.background.ignoresSafeArea()
        ScrollView {
            SettingsParentalTab(daemonClient: nil, settingsStore: SettingsStore())
                .padding(VSpacing.xl)
        }
    }
    .frame(width: 420, height: 600)
}

#Preview("Activity Log Entry Row") {
    struct PreviewWrapper: View {
        var body: some View {
            VStack(spacing: VSpacing.sm) {
                ActivityLogEntryRow(entry: ActivityLogEntry(
                    id: "1",
                    timestamp: "2026-02-26T10:00:00Z",
                    actionType: "tool_call",
                    description: "Called bash tool with command: ls -la"
                ))
                ActivityLogEntryRow(entry: ActivityLogEntry(
                    id: "2",
                    timestamp: "2026-02-26T10:05:00Z",
                    actionType: "approval_request",
                    description: "Requested approval to access file system"
                ))
            }
            .padding(VSpacing.lg)
            .background(VColor.background)
        }
    }
    return PreviewWrapper()
}
