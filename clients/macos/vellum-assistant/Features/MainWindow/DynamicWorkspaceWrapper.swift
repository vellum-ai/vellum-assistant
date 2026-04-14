import SwiftUI
import VellumAssistantShared

/// Observes the active ChatViewModel and renders the dynamic workspace overlays.
struct DynamicWorkspaceWrapper: View {
    var viewModel: ChatViewModel
    let surface: Surface
    let data: DynamicPageSurfaceData
    @ObservedObject var windowState: MainWindowState
    let surfaceManager: SurfaceManager
    let connectionManager: GatewayConnectionManager
    let trafficLightPadding: CGFloat
    let isSidebarOpen: Bool
    var sharing: SharingState
    let gatewayBaseURL: String
    let onPublishPage: (String, String?, String?) -> Void
    let onBundleAndShare: (String) -> Void
    let isChatDockOpen: Bool
    let onToggleChatDock: () -> Void
    let onMicrophoneToggle: () -> Void
    var featureFlagClient: FeatureFlagClientProtocol = FeatureFlagClient()

    @State private var showVersionHistory = false
    @State private var publishUrlCopied = false
    @State private var showShareDrawer = false
    @State private var shareButtonFrame: CGRect = .zero
    @State private var isDeployToVercelEnabled = false
    @State private var inAppBrowserURL: URL?

    private static let deployToVercelFlagKey = "deploy-to-vercel"

    /// Corner radius for the WKWebView clipping container — no rounding needed since the
    /// outer page container handles corner rounding.
    private var webViewCornerRadius: CGFloat { 0 }

    private var webViewMaskedCorners: CACornerMask { [] }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                // Left: Close Chat primary CTA in edit mode, Edit primary button otherwise
                if case .appEditing = windowState.selection {
                    VButton(label: "Close chat", icon: VIcon.x.rawValue, style: .primary) {
                        onToggleChatDock()
                    }
                } else {
                    VButton(label: "Edit", icon: VIcon.pencil.rawValue, style: .primary) {
                        if !isChatDockOpen {
                            windowState.workspaceComposerExpanded = false
                        }
                        onToggleChatDock()
                    }
                    .accessibilityLabel("Edit app")
                }

                Spacer(minLength: 0)

                Text(surface.title ?? data.preview?.title ?? "App")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(1)

                Spacer(minLength: 0)

                // Right: History + Share + Close outlined icon buttons
                HStack(spacing: VSpacing.sm) {
                    if data.appId != nil {
                        VButton(label: "Version history", iconOnly: VIcon.history.rawValue, style: .outlined, iconSize: 32, tooltip: "Version history") {
                            showVersionHistory = true
                        }
                    }

                    if let url = sharing.publishedUrl {
                        PublishedButton(url: url, copied: $publishUrlCopied)
                    }

                    ZStack {
                        if data.appId != nil {
                            if sharing.isBundling || sharing.isPublishing {
                                ProgressView()
                                    .controlSize(.small)
                                    .frame(height: 32)
                            } else {
                                VButton(label: "Share", iconOnly: VIcon.share.rawValue, style: .outlined, iconSize: 32, tooltip: "Share") {
                                    if isDeployToVercelEnabled {
                                        showShareDrawer.toggle()
                                    } else if let appId = data.appId {
                                        onBundleAndShare(appId)
                                    }
                                }
                                .onGeometryChange(for: CGRect.self) { proxy in
                                    proxy.frame(in: .named("appPageContainer"))
                                } action: { newFrame in
                                    shareButtonFrame = newFrame
                                }
                                .overlay {
                                    AppSharePanel(
                                        items: sharing.shareFileURL != nil ? [sharing.shareFileURL!] : [],
                                        isPresented: Binding(
                                            get: { sharing.showSharePicker },
                                            set: { sharing.showSharePicker = $0 }
                                        ),
                                        appName: sharing.shareAppName,
                                        appIcon: sharing.shareAppIcon,
                                        appId: sharing.shareAppId,
                                        gatewayBaseURL: gatewayBaseURL
                                    )
                                    .allowsHitTesting(false)
                                }
                            }
                        } else if sharing.isPublishing {
                            ProgressView()
                                .controlSize(.small)
                                .frame(height: 32)
                        } else if sharing.publishedUrl == nil && isDeployToVercelEnabled {
                            VButton(label: "Publish", iconOnly: VIcon.arrowUpRight.rawValue, style: .outlined, iconSize: 32, tooltip: "Publish to Vercel") {
                                onPublishPage(data.html, data.preview?.title, data.appId)
                            }
                        }
                    }

                    VButton(label: "Close workspace", iconOnly: VIcon.x.rawValue, style: .outlined, iconSize: 32, tooltip: "Close workspace") {
                        sharing.showSharePicker = false
                        windowState.clearDynamicWorkspaceState()
                        windowState.dismissOverlay()
                    }
                }
            }
            .padding(.leading, VSpacing.md)
            .padding(.trailing, VSpacing.md)
            .padding(.vertical, VSpacing.md)
            .background(
                VColor.surfaceOverlay
            )
            .overlay(alignment: .bottom) {
                VColor.borderBase
                    .frame(height: 1)
            }

            if let error = sharing.publishError {
                HStack {
                    Spacer()
                    Text(error)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.systemNegativeStrong)
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.xs)
                        .background(VColor.systemNegativeWeak)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        .padding(.trailing, VSpacing.xl)
                }
            }

            ZStack {
                DynamicPageSurfaceView(
                    data: data,
                    onAction: { actionId, actionData in
                        if !isChatDockOpen {
                            onToggleChatDock()
                        }
                        // Route relay_prompt actions directly as chat messages so they
                        // reach the active session instead of being lost when the surface
                        // was opened outside a session context (e.g. via app_open).
                        if actionId == "relay_prompt" || actionId == "agent_prompt",
                           let dataDict = actionData as? [String: Any],
                           let prompt = dataDict["prompt"] as? String,
                           !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            // Eagerly sync dock state so sendMessage() sees the
                            // up-to-date value instead of the stale pre-toggle state
                            // (onChange(of: windowState.selection) runs asynchronously).
                            viewModel.isChatDockedToSide = true
                            viewModel.inputText = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
                            viewModel.sendMessage()
                            return
                        }
                        surfaceManager.onAction?(surface.conversationId, surface.id, actionId, actionData as? [String: Any])
                    },
                    appId: data.appId,
                    onDataRequest: data.appId != nil ? { callId, method, recordId, requestData in
                        guard let appId = surfaceManager.surfaceAppIds[surface.id] else { return }
                        surfaceManager.onDataRequest?(surface.id, callId, method, appId, recordId, requestData)
                    } : nil,
                    onCoordinatorReady: data.appId != nil ? { coordinator in
                        surfaceManager.surfaceCoordinators[surface.id] = coordinator
                    } : nil,
                    onPageChanged: { [weak viewModel] page in
                        viewModel?.currentPage = page
                    },
                    onSnapshotCaptured: data.appId != nil ? { base64 in
                        guard let appId = data.appId else { return }
                        Task { await AppsClient().updateAppPreview(appId: appId, preview: base64) }
                        NotificationCenter.default.post(
                            name: .appPreviewImageCaptured,
                            object: nil,
                            userInfo: ["appId": appId, "previewImage": base64]
                        )
                    } : nil,
                    onLinkOpen: { url, metadata in
                        surfaceManager.onLinkOpen?(url, metadata)
                    },
                    onOpenInAppBrowser: { url in
                        inAppBrowserURL = url
                    },
                    topContentInset: 0,
                    bottomContentInset: 0,
                    cornerRadius: webViewCornerRadius,
                    maskedCorners: webViewMaskedCorners
                )
                .opacity(showVersionHistory || inAppBrowserURL != nil ? 0 : 1)
                .allowsHitTesting(!showVersionHistory && inAppBrowserURL == nil)

                if let browserURL = inAppBrowserURL {
                    InAppBrowserView(
                        url: browserURL,
                        onClose: { inAppBrowserURL = nil },
                        onOpenExternal: { url in
                            NSWorkspace.shared.open(url)
                        }
                    )
                }

                if showVersionHistory, let appId = data.appId {
                    AppVersionHistoryPanel(
                        connectionManager: connectionManager,
                        appId: appId,
                        appName: data.preview?.title ?? "App",
                        onClose: { showVersionHistory = false }
                    )
                }
            }
        }
        .coordinateSpace(name: "appPageContainer")
        .overlay(alignment: .topLeading) {
            if showShareDrawer {
                // Dismiss backdrop
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { showShareDrawer = false }
            }
        }
        .overlay(alignment: .topLeading) {
            if showShareDrawer, let appId = data.appId {
                ShareDrawer(
                    onShare: {
                        showShareDrawer = false
                        onBundleAndShare(appId)
                    },
                    onPublish: {
                        showShareDrawer = false
                        onPublishPage(data.html, data.preview?.title, data.appId)
                    },
                    isDeployToVercelEnabled: isDeployToVercelEnabled
                )
                .offset(
                    x: shareButtonFrame.maxX - 180,
                    y: shareButtonFrame.maxY + VSpacing.xs
                )
                .zIndex(10)
                .transition(.opacity)
            }
        }
        .task {
            do {
                let flags = try await featureFlagClient.getFeatureFlags()
                if let flag = flags.first(where: { $0.key == Self.deployToVercelFlagKey }) {
                    isDeployToVercelEnabled = flag.enabled
                }
            } catch {
                // Flag stays disabled on error
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantFeatureFlagDidChange)) { notification in
            if let key = notification.userInfo?["key"] as? String,
               let enabled = notification.userInfo?["enabled"] as? Bool,
               key == Self.deployToVercelFlagKey {
                isDeployToVercelEnabled = enabled
            }
        }
    }
}

// MARK: - Supporting Views

/// Shows "Published ✓" with an inline copy-to-clipboard button.
/// Tapping the copy icon copies the URL and briefly shows a checkmark.
private struct PublishedButton: View {
    let url: String
    @Binding var copied: Bool

    @State private var isCopyHovered = false
    @State private var resetTask: Task<Void, Never>?

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(.check, size: 10)
                .foregroundStyle(VColor.systemPositiveStrong)
            Text("Published")
                .font(VFont.labelDefault)
            Divider()
                .frame(height: 12)
            VIconView(copied ? .check : .copy, size: 10)
                .foregroundStyle(copied ? VColor.systemPositiveStrong : (isCopyHovered ? VColor.contentDefault : VColor.primaryBase))
                .animation(VAnimation.fast, value: copied)
                .contentShape(Rectangle())
                .onTapGesture {
                    resetTask?.cancel()
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url, forType: .string)
                    copied = true
                    resetTask = Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        guard !Task.isCancelled else { return }
                        copied = false
                    }
                }
                .onHover { hovering in
                    isCopyHovered = hovering
                }
                .pointerCursor()
                .accessibilityLabel(copied ? "URL copied" : "Copy published URL")
        }
        .foregroundStyle(VColor.primaryBase)
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.buttonV)
        .frame(height: 24)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderActive, lineWidth: 1)
        )
        .controlSize(.small)
    }
}

// MARK: - Share Drawer

/// Popover menu with "Share" and optionally "Publish to Vercel" options.
/// Styled to match ConversationSwitcherDrawer / DrawerMenuView.
private struct ShareDrawer: View {
    let onShare: () -> Void
    let onPublish: () -> Void
    let isDeployToVercelEnabled: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VNavItem(icon: VIcon.share.rawValue, label: "Share") { onShare() }
            if isDeployToVercelEnabled {
                VColor.borderBase.frame(height: 1)
                    .padding(.horizontal, VSpacing.xs)
                VNavItem(icon: VIcon.arrowUpRight.rawValue, label: "Publish to Vercel") { onPublish() }
            }
        }
        .padding(.vertical, VSpacing.xs)
        .frame(width: 180)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .shadow(color: VColor.auxBlack.opacity(0.15), radius: 6, y: 2)
    }
}

