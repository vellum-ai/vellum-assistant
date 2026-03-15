#if os(macOS)
import Combine
import SwiftUI
import AppKit
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "TaskProgressOverlay")

/// Manages a floating NSPanel that shows a task_progress widget pinned to the
/// top-right of the screen. Follows BrowserPiPManager / SessionOverlayWindow patterns.
@MainActor
public final class TaskProgressOverlayManager: ObservableObject {
    public static let shared = TaskProgressOverlayManager()

    @Published var data: TaskProgressData?
    /// The surface ID currently shown in the floating overlay.
    /// ChatView uses this to suppress inline rendering for the same surface.
    @Published public private(set) var activeSurfaceId: String?

    private var panel: NSPanel?
    private var dismissTask: Task<Void, Never>?

    // MARK: - Debug publish-rate counters

    #if DEBUG
    private static let perfLog = OSLog(subsystem: "com.vellum.assistant", category: "PerfCounters")
    private var publishCount = 0
    private var lastRateLogTime = Date()
    private var debugCancellable: AnyCancellable?

    private func trackPublish() {
        publishCount += 1
        let now = Date()
        if now.timeIntervalSince(lastRateLogTime) >= 5 {
            os_log(.debug, log: Self.perfLog, "TaskProgressOverlayManager publish rate: %d/5s", publishCount)
            publishCount = 0
            lastRateLogTime = now
        }
    }
    #endif

    private init() {
        #if DEBUG
        // Observe own objectWillChange to track publish frequency.
        debugCancellable = self.objectWillChange
            .sink { [weak self] _ in self?.trackPublish() }
        #endif
    }

    // MARK: - Public API

    public func show(data: TaskProgressData, surfaceId: String) {
        dismissTask?.cancel()
        dismissTask = nil
        self.activeSurfaceId = surfaceId
        self.data = data

        if panel == nil {
            createPanel()
        }
        // Reset alpha in case we're racing with a fade-out animation from closePanel()
        panel?.alphaValue = 0.9
        panel?.orderFront(nil)
        log.info("Showing task progress overlay: surfaceId=\(surfaceId, privacy: .public)")
    }

    public func update(data: TaskProgressData, surfaceId: String) {
        guard surfaceId == self.activeSurfaceId else { return }
        self.data = data

        // Resize panel to fit updated content
        if let panel, let fittingSize = panel.contentView?.fittingSize {
            panel.setContentSize(fittingSize)
        }

        // Auto-dismiss when all steps are completed
        if data.status == "completed" || data.steps.allSatisfy({ $0.status == "completed" }) {
            scheduleDismiss()
        }
    }

    public func dismiss(surfaceId: String) {
        guard surfaceId == self.activeSurfaceId else { return }
        scheduleDismiss()
    }

    /// Immediately close the overlay (e.g. user tapped the X button).
    public func close() {
        dismissTask?.cancel()
        dismissTask = nil
        closePanel()
    }

    // MARK: - Private

    private func scheduleDismiss() {
        dismissTask?.cancel()
        dismissTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { return }
            self?.closePanel()
        }
    }

    private func closePanel() {
        // Capture and nil the panel reference synchronously to prevent
        // show() from reusing a panel that's mid-fade-out.
        let closingPanel = panel
        panel = nil
        activeSurfaceId = nil
        data = nil
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.3
            closingPanel?.animator().alphaValue = 0
        }, completionHandler: {
            closingPanel?.close()
        })
        log.info("Dismissed task progress overlay")
    }

    private func createPanel() {
        let view = TaskProgressOverlayView(manager: self)
        let hostingController = NSHostingController(rootView: view)

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 280, height: 200),
            styleMask: [.titled, .nonactivatingPanel, .utilityWindow, .hudWindow],
            backing: .buffered,
            defer: false
        )
        panel.contentViewController = hostingController
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.alphaValue = 0.9
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hasShadow = true

        // Position top-right of screen
        positionTopRight(panel)

        self.panel = panel
    }

    private func positionTopRight(_ panel: NSPanel) {
        guard let screen = NSScreen.main else { return }
        let padding: CGFloat = 20
        if let fittingSize = panel.contentView?.fittingSize {
            panel.setContentSize(fittingSize)
        }
        let frame = panel.frame
        let x = screen.visibleFrame.maxX - frame.width - padding
        let y = screen.visibleFrame.maxY - frame.height - padding
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }
}

// MARK: - Overlay SwiftUI View

private struct TaskProgressOverlayView: View {
    @ObservedObject var manager: TaskProgressOverlayManager

    var body: some View {
        VStack(spacing: 0) {
            if let data = manager.data {
                HStack {
                    Spacer()
                    Button {
                        manager.close()
                    } label: {
                        VIconView(.x, size: 10)
                            .foregroundColor(VColor.contentSecondary)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, VSpacing.sm)
                    .padding(.trailing, VSpacing.sm)
                }
                InlineTaskProgressWidget(data: data)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.bottom, VSpacing.md)
            }
        }
        .frame(width: 260)
        .background(VColor.surfaceOverlay)
    }
}
#endif
