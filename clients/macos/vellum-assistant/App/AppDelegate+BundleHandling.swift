import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate+BundleHandling")

extension AppDelegate {

    // MARK: - File Open Handler

    public func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard url.pathExtension == "vellum" else { continue }
            log.info("Opening .vellum file: \(url.path, privacy: .private)")

            guard daemonClient.isConnected else {
                log.warning("Cannot open bundle: daemon not connected")
                continue
            }

            do {
                pendingBundleFilePaths.append(url.path)
                try daemonClient.sendOpenBundle(filePath: url.path)
            } catch {
                log.error("Failed to send open_bundle message: \(error.localizedDescription)")
                // Remove the path we just appended since the send failed
                if let idx = pendingBundleFilePaths.lastIndex(of: url.path) {
                    pendingBundleFilePaths.remove(at: idx)
                }
            }
        }
    }

    // MARK: - Bundle Open Handling

    func handleOpenBundleResponse(_ response: OpenBundleResponseMessage) {
        let filePath = pendingBundleFilePaths.isEmpty ? "" : pendingBundleFilePaths.removeFirst()

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
        manifest: IPCOpenBundleResponseManifest,
        signatureResult: IPCOpenBundleResponseSignatureResult,
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
                    log.info("Loading shared app at \(entryURL, privacy: .private)")

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
                        sessionId: "shared-app",
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
