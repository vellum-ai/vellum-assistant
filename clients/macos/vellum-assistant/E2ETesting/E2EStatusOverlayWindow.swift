import AppKit
import SwiftUI
import VellumAssistantShared

/// Floating overlay that displays real-time e2e test agent progress.
///
/// Positioned in the bottom-left corner of the screen, this panel reads
/// a JSON status file written by the Playwright agent and updates the
/// display each time the file changes. Enabled via the `E2E_STATUS_FILE`
/// environment variable so it only appears during automated test runs.
@MainActor
final class E2EStatusOverlayWindow {
    private var panel: NSPanel?
    private var viewModel: E2EStatusOverlayViewModel?

    private let statusFilePath: String

    init(statusFilePath: String) {
        self.statusFilePath = statusFilePath
    }

    func show() {
        dismiss()

        let vm = E2EStatusOverlayViewModel(statusFilePath: statusFilePath)
        self.viewModel = vm

        let hostingController = NSHostingController(rootView: E2EStatusOverlayView(viewModel: vm))

        let overlayPanel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 72),
            styleMask: [.nonactivatingPanel, .hudWindow, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        overlayPanel.contentViewController = hostingController
        overlayPanel.title = "E2E Status Overlay"
        overlayPanel.isFloatingPanel = true
        overlayPanel.level = .statusBar
        overlayPanel.isMovableByWindowBackground = true
        overlayPanel.backgroundColor = .clear
        overlayPanel.isOpaque = false
        overlayPanel.hasShadow = true
        overlayPanel.isReleasedWhenClosed = false
        overlayPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.minX + 16
            let y = screenFrame.minY + 16
            overlayPanel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        overlayPanel.orderFront(nil)
        self.panel = overlayPanel

        vm.startWatching()
    }

    func dismiss() {
        viewModel?.stopWatching()
        panel?.close()
        panel = nil
        viewModel = nil
    }
}

// MARK: - Status Model

struct E2EStatus: Codable {
    let iteration: Int
    let maxIterations: Int
    let tool: String
    let summary: String
    let elapsed: String
    let testName: String
}

// MARK: - View Model

@MainActor
final class E2EStatusOverlayViewModel: ObservableObject {
    @Published var currentStatus: E2EStatus?

    private let statusFilePath: String
    private var pollTimer: Timer?

    init(statusFilePath: String) {
        self.statusFilePath = statusFilePath
    }

    func startWatching() {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.readStatusFile()
            }
        }
    }

    func stopWatching() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func readStatusFile() {
        guard let data = FileManager.default.contents(atPath: statusFilePath) else { return }
        guard let status = try? JSONDecoder().decode(E2EStatus.self, from: data) else { return }
        currentStatus = status
    }
}

// MARK: - View

struct E2EStatusOverlayView: View {
    @ObservedObject var viewModel: E2EStatusOverlayViewModel

    @State private var dotOpacity: Double = 1.0

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            if let status = viewModel.currentStatus {
                HStack(spacing: VSpacing.sm) {
                    Circle()
                        .fill(VColor.primaryBase)
                        .frame(width: 8, height: 8)
                        .opacity(dotOpacity)
                        .onAppear {
                            withAnimation(
                                .easeInOut(duration: 0.8)
                                .repeatForever(autoreverses: true)
                            ) {
                                dotOpacity = 0.3
                            }
                        }

                    Text("E2E")
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.contentSecondary)

                    Text(status.testName)
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.contentDefault)
                        .lineLimit(1)

                    Spacer()

                    Text("Step \(status.iteration)")
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.contentSecondary)
                        .monospacedDigit()

                    Text(status.elapsed)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.contentSecondary)
                        .monospacedDigit()
                }

                HStack(spacing: VSpacing.xs) {
                    VIconView(.terminal, size: 12)
                        .foregroundColor(VColor.primaryBase)

                    Text(status.summary)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            } else {
                HStack(spacing: VSpacing.sm) {
                    Circle()
                        .fill(VColor.systemNegativeHover)
                        .frame(width: 8, height: 8)

                    Text("E2E — Waiting for agent...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                }
            }
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceBase)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )
        )
        .frame(width: 320)
    }
}
