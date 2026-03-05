import AppKit
import Sentry
import SwiftUI
import VellumAssistantShared

/// Shown on the first launch after a crash. Lets the user review the crash log
/// and send it to the development team, or dismiss without sending.
@MainActor
struct CrashReportView: View {
    let crashURL: URL
    let crashLog: String
    let onDismiss: () -> Void

    @State private var isSending = false
    @State private var didSend = false
    @State private var dismissTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            header
            logPreview
            if didSend { sentConfirmation }
            actionRow
        }
        .padding(VSpacing.lg)
        .background(VColor.background)
        .frame(width: 520)
    }

    // MARK: - Sections

    private var header: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(VColor.warning)
                .font(.system(size: 22))
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text("The app crashed last session")
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)
                Text("Would you like to send the crash log to help us fix the issue? No personal data or message content is included.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var logPreview: some View {
        ScrollView {
            Text(crashLog)
                .font(VFont.monoSmall)
                .foregroundColor(VColor.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .frame(maxHeight: 260)
        .padding(VSpacing.sm)
        .background(VColor.backgroundSubtle)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    private var sentConfirmation: some View {
        HStack(spacing: VSpacing.xs) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundColor(VColor.success)
            Text("Crash report sent. Thank you!")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
    }

    private var actionRow: some View {
        HStack {
            Spacer()
            Button("Dismiss") {
                dismissTask?.cancel()
                CrashReporter.markAsSeen(crashURL)
                onDismiss()
            }
            .buttonStyle(.bordered)
            .disabled(isSending)

            Button(isSending ? "Sending…" : "Send Report") {
                sendReport()
            }
            .buttonStyle(.borderedProminent)
            .disabled(isSending || didSend)
        }
    }

    // MARK: - Sending

    private func sendReport() {
        isSending = true
        let logContent = crashLog
        let crashFileName = crashURL.lastPathComponent
        let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        let urlCopy = crashURL

        Task.detached {
            let event = Event(level: .fatal)
            event.message = SentryMessage(formatted: "Crash report: \(crashFileName)")
            event.tags = ["source": "crash_log", "app_version": appVersion]
            // Truncate to ~8 KB to stay within Sentry's event size limits.
            let truncated = logContent.count > 8_192
                ? String(logContent.prefix(8_192)) + "\n[truncated]"
                : logContent
            event.extra = ["crash_log": truncated, "crash_file": crashFileName]

            // Await completion so UI confirms delivery only after flush finishes.
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                MetricKitManager.sendManualReport(event) {
                    continuation.resume()
                }
            }

            await MainActor.run {
                isSending = false
                didSend = true
                CrashReporter.markAsSeen(urlCopy)
                // Auto-dismiss after a short delay so the user sees the confirmation.
                dismissTask = Task {
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    guard !Task.isCancelled else { return }
                    onDismiss()
                }
            }
        }
    }
}

// MARK: - Window helper

extension AppDelegate {
    /// Opens a crash report window if a crash log from the previous session exists.
    /// Call early in `applicationDidFinishLaunching`, before `recordLaunch()`.
    func checkForPreviousCrash() {
        guard let (url, content) = CrashReporter.pendingCrashLog() else {
            CrashReporter.recordLaunch()
            return
        }

        // Record now so a second launch doesn't surface the same crash again
        // even if the user force-quits before dismissing the sheet.
        CrashReporter.recordLaunch()
        showCrashReportWindow(url: url, content: content)
    }

    func showCrashReportWindow(url: URL, content: String) {
        let dismiss: () -> Void = { [weak self] in
            self?.dismissCrashReportWindow()
        }

        let view = CrashReportView(
            crashURL: url,
            crashLog: content,
            onDismiss: dismiss
        )

        let hostingController = NSHostingController(rootView: view)
        hostingController.sizingOptions = []
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 480),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = hostingController
        window.title = "Crash Report"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(VColor.background)
        window.isReleasedWhenClosed = false
        window.center()

        // Handle native close-button dismissal so crashReportWindow is cleared
        // and activation policy is reverted even when the user clicks the red ✕.
        // Store the token so the observer can be removed and doesn't leak.
        crashReportWindowObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.handleCrashReportWindowWillClose()
            }
        }

        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        crashReportWindow = window
    }

    private func dismissCrashReportWindow() {
        if let observer = crashReportWindowObserver {
            NotificationCenter.default.removeObserver(observer)
            crashReportWindowObserver = nil
        }
        crashReportWindow?.close()
        crashReportWindow = nil
        scheduleActivationPolicyRevert()
    }

    private func handleCrashReportWindowWillClose() {
        if let observer = crashReportWindowObserver {
            NotificationCenter.default.removeObserver(observer)
            crashReportWindowObserver = nil
        }
        crashReportWindow = nil
        scheduleActivationPolicyRevert()
    }
}

#Preview("CrashReportView") {
    CrashReportView(
        crashURL: URL(fileURLWithPath: "/tmp/vellum-assistant_2026-03-05.crash"),
        crashLog: """
        Process:         vellum-assistant [1234]
        Path:            /Applications/Vellum.app/Contents/MacOS/vellum-assistant
        Identifier:      com.vellum.vellum-assistant
        Version:         1.0.0

        Thread 0 Crashed:
        0   vellum-assistant    0x0000000100abc123 main + 0
        1   dyld                0x00007fff6bc123ab start + 1
        """,
        onDismiss: {}
    )
}
