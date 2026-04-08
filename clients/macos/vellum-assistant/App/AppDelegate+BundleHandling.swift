import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppDelegate+BundleHandling")

extension AppDelegate {

    // MARK: - File Open Handler

    public func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            // Handle vellum://send?message=... deep links
            if url.scheme == "vellum" || url.scheme == "vellum-assistant" {
                handleDeepLink(url)
                continue
            }

            guard url.pathExtension == "vellum" else { continue }
            log.info("Opening .vellum file: \(url.path, privacy: .public)")

            let path = url.path
            Task { @MainActor in
                let result = await AppsClient().openBundle(filePath: path)
                if let result {
                    self.handleOpenBundleResponse(result, filePath: path)
                } else {
                    log.error("Failed to open bundle at \(path, privacy: .public)")
                }
            }
        }
    }

    /// Handle `vellum://send?message=...[&assistant=<id>]` deep links by
    /// buffering the message in `DeepLinkManager` for the active
    /// `ChatViewModel` to consume, optionally switching to the requested
    /// assistant first, then bringing the main window to front.
    ///
    /// Routing behavior is decided by `DeepLinkRouter.decide(...)`; this
    /// method is the side-effect layer that applies the chosen decision.
    private func handleDeepLink(_ url: URL) {
        let knownAssistantIds = Set(LockfileAssistant.loadAll().map(\.assistantId))
        let multiAssistantEnabled = AssistantFeatureFlagResolver.isEnabled("multi-platform-assistant")

        let decision = DeepLinkRouter.decide(
            url: url,
            knownAssistantIds: knownAssistantIds,
            multiAssistantEnabled: multiAssistantEnabled
        )

        switch decision {
        case .ignore:
            return

        case .routeToActive(let message):
            log.info("Received deep link send message (\(message.count) chars)")
            deliverDeepLinkToActiveAssistant(message: message)

        case .routeToActiveAfterUnknownAssistant(let requestedAssistantId, let message):
            log.warning("Deep link requested unknown assistant \(requestedAssistantId, privacy: .public); falling back to active assistant")
            deliverDeepLinkToActiveAssistant(message: message)

        case .switchLive(let assistantId, let message):
            log.info("Deep link switching live to assistant \(assistantId, privacy: .public) (\(message.count) chars)")
            guard let assistant = LockfileAssistant.loadByName(assistantId) else {
                // Race: the assistant disappeared from the lockfile between
                // the decision and now. Fall back to delivering to the active
                // assistant rather than dropping the message.
                log.warning("Assistant \(assistantId, privacy: .public) disappeared from lockfile before switch; delivering to active")
                deliverDeepLinkToActiveAssistant(message: message)
                return
            }
            // `performSwitchAssistant` early-returns for managed assistants
            // when the user is logged out (it shows the auth window). That
            // path doesn't close the old main window or consume pending
            // messages, which would orphan the deep-link message until a
            // future conversation change. Skip the switch entirely in that
            // case and deliver the message to the currently active
            // assistant instead.
            if assistant.isManaged && !authManager.isAuthenticated {
                log.warning("Deep link switch to managed assistant \(assistantId, privacy: .public) skipped — not authenticated; delivering to active assistant")
                deliverDeepLinkToActiveAssistant(message: message)
                return
            }
            DeepLinkManager.pendingMessage = message
            performSwitchAssistant(to: assistant)

        case .routeToActiveFlagOff(let requestedAssistantId, let message):
            // Flag is off — we intentionally do not mutate `activeAssistant`
            // here. Writing a new active id without a corresponding SSE
            // reconnect would desync HTTP routing from SSE (see
            // `DeepLinkRoutingDecision.routeToActiveFlagOff`). Deliver to
            // whatever is currently active instead.
            log.warning("Deep link requested assistant \(requestedAssistantId, privacy: .public) but multi-platform-assistant flag is off; delivering to active assistant")
            deliverDeepLinkToActiveAssistant(message: message)
        }
    }

    /// Buffer the message in `DeepLinkManager`, show the main window, and
    /// ask the active conversation view model to consume it.
    private func deliverDeepLinkToActiveAssistant(message: String) {
        DeepLinkManager.pendingMessage = message
        showMainWindow()
        mainWindow?.conversationManager.activeViewModel?.consumeDeepLinkIfNeeded()
    }

    // MARK: - Bundle Open Handling

    func handleOpenBundleResponse(_ response: OpenBundleResponseMessage, filePath: String = "") {

        // Check format version compatibility (1 = legacy single-HTML, 2 = multi-file TSX)
        if response.manifest.format_version > 2 {
            let alert = NSAlert()
            alert.messageText = "Incompatible App"
            alert.informativeText = "This app requires a newer version of vellum-assistant."
            alert.alertStyle = .warning
            alert.addButton(withTitle: "OK")
            alert.runModal()
            return
        }

        // If scan blocked, show error alert
        if !response.scanResult.passed {
            let reason = response.scanResult.blocked.first ?? "Unknown security issue"
            let alert = NSAlert()
            alert.messageText = "This app can't be opened"
            alert.informativeText = "Security scan found: \(reason)"
            alert.alertStyle = .critical
            alert.addButton(withTitle: "OK")
            alert.runModal()
            return
        }

        // Show confirmation dialog
        let viewModel = BundleConfirmationViewModel(
            response: response,
            filePath: filePath
        )

        let confirmWindow = BundleConfirmationWindow()
        self.bundleConfirmationWindow = confirmWindow

        viewModel.onConfirm = { [weak self, weak viewModel] in
            guard let self, let viewModel else { return }
            viewModel.installState = .installing
            self.unpackAndLoadBundle(
                filePath: filePath,
                manifest: response.manifest,
                signatureResult: response.signatureResult,
                bundleSizeBytes: response.bundleSizeBytes,
                onSuccess: {
                    viewModel.installState = .installed
                    // Auto-close after brief success feedback
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(500))
                        confirmWindow.close()
                        self.bundleConfirmationWindow = nil
                    }
                },
                onError: { errorMessage in
                    viewModel.installState = .error(errorMessage)
                }
            )
        }

        viewModel.onCancel = { [weak self] in
            confirmWindow.close()
            self?.bundleConfirmationWindow = nil
        }

        confirmWindow.show(viewModel: viewModel)
    }

    func unpackAndLoadBundle(
        filePath: String,
        manifest: OpenBundleResponseManifest,
        signatureResult: OpenBundleResponseSignatureResult,
        bundleSizeBytes: Int,
        onSuccess: (() -> Void)? = nil,
        onError: ((String) -> Void)? = nil
    ) {
        // Run the unzip on a background thread to avoid blocking the UI.
        Task.detached {
            do {
                let (uuid, _) = try BundleSandbox.unpack(
                    filePath: filePath,
                    manifest: manifest,
                    signatureResult: signatureResult,
                    bundleSizeBytes: bundleSizeBytes
                )

                await MainActor.run {
                    // Build the vellumapp:// URL for the entry point.
                    // Sanitize manifest.entry to prevent JS string breakout.
                    let sanitizedEntry = manifest.entry
                        .replacingOccurrences(of: "\\", with: "")
                        .replacingOccurrences(of: "'", with: "")
                    let entryURL = "\(VellumAppSchemeHandler.scheme)://\(uuid)/\(sanitizedEntry)"
                    log.info("Loading shared app at \(entryURL, privacy: .public)")

                    // HTML-escape manifest.name to prevent XSS injection.
                    let safeName = Self.htmlEscape(manifest.name)

                    // Load the shared app as a surface via SurfaceManager
                    let surfaceId = "shared-app-\(uuid)"
                    let html = """
                    <!DOCTYPE html>
                    <html>
                    <head><meta charset="utf-8"><title>\(safeName)</title></head>
                    <body>
                        <script>window.location.href = '\(entryURL)';</script>
                    </body>
                    </html>
                    """
                    let surfaceMsg = UiSurfaceShowMessage(
                        conversationId: "shared-app",
                        surfaceId: surfaceId,
                        surfaceType: "dynamic_page",
                        title: manifest.name,
                        data: AnyCodable(["html": html]),
                        actions: nil,
                        display: "panel",
                        messageId: nil
                    )
                    self.surfaceManager.showSurface(surfaceMsg)
                    onSuccess?()
                }
            } catch {
                await MainActor.run {
                    log.error("Failed to unpack bundle: \(error.localizedDescription)")
                    if let onError {
                        onError(error.localizedDescription)
                    } else {
                        let alert = NSAlert()
                        alert.messageText = "Failed to open app"
                        alert.informativeText = error.localizedDescription
                        alert.alertStyle = .critical
                        alert.addButton(withTitle: "OK")
                        alert.runModal()
                    }
                }
            }
        }
    }

    /// HTML-escape a string to prevent injection when interpolated into HTML.
    static func htmlEscape(_ string: String) -> String {
        string
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}
