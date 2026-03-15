import AppKit
import SwiftUI
import VellumAssistantShared

/// Recording indicator HUD that shows a red dot, elapsed time, and stop button.
///
/// Floats as a small panel in the top-right corner of the screen during
/// an active recording. Supports pause/resume toggle. Uses design system
/// tokens for styling.
@MainActor
final class RecordingHUDWindow {
    private var panel: NSPanel?
    private var viewModel: RecordingHUDViewModel?

    /// Show the recording HUD.
    ///
    /// - Parameters:
    ///   - onStop: Called when the user clicks the stop button.
    ///   - onPauseResume: Called when the user toggles pause/resume. The
    ///     Bool parameter is `true` when requesting pause, `false` for resume.
    func show(onStop: @escaping () -> Void, onPauseResume: ((Bool) -> Void)? = nil) {
        dismiss()

        let vm = RecordingHUDViewModel(onStop: onStop, onPauseResume: onPauseResume)
        self.viewModel = vm

        let hudView = RecordingHUDView(viewModel: vm)
        let hostingController = NSHostingController(rootView: hudView)

        let hudPanel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 220, height: 44),
            styleMask: [.nonactivatingPanel, .hudWindow, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        hudPanel.contentViewController = hostingController
        hudPanel.isFloatingPanel = true
        hudPanel.level = .statusBar
        hudPanel.isMovableByWindowBackground = true
        hudPanel.backgroundColor = .clear
        hudPanel.isOpaque = false
        hudPanel.hasShadow = true
        hudPanel.isReleasedWhenClosed = false
        hudPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        // Position in the top-right corner
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.maxX - 236
            let y = screenFrame.maxY - 60
            hudPanel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        hudPanel.orderFront(nil)
        self.panel = hudPanel
    }

    /// Update the HUD to reflect paused state.
    func setPaused(_ paused: Bool) {
        viewModel?.isPaused = paused
        if paused {
            viewModel?.pauseTimer()
        } else {
            viewModel?.resumeTimer()
        }
    }

    /// Update the HUD to show a failure message.
    func showFailure(_ message: String) {
        viewModel?.failureMessage = message
        viewModel?.isRecording = false
    }

    /// Dismiss the recording HUD.
    func dismiss() {
        viewModel?.stopTimer()
        panel?.close()
        panel = nil
        viewModel = nil
    }
}

// MARK: - View Model

@MainActor
final class RecordingHUDViewModel: ObservableObject {
    @Published var elapsedSeconds: Int = 0
    @Published var isRecording = true
    @Published var isPaused = false
    @Published var failureMessage: String?

    private var timer: Timer?
    private let onStop: () -> Void
    private let onPauseResume: ((Bool) -> Void)?

    init(onStop: @escaping () -> Void, onPauseResume: ((Bool) -> Void)? = nil) {
        self.onStop = onStop
        self.onPauseResume = onPauseResume
        startTimer()
    }

    func startTimer() {
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.elapsedSeconds += 1
            }
        }
    }

    /// Pause the elapsed-time timer (called when recording is paused).
    func pauseTimer() {
        timer?.invalidate()
        timer = nil
    }

    /// Resume the elapsed-time timer (called when recording is resumed).
    func resumeTimer() {
        guard timer == nil else { return }
        startTimer()
    }

    func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    func stop() {
        stopTimer()
        onStop()
    }

    func togglePauseResume() {
        let requestPause = !isPaused
        onPauseResume?(requestPause)
    }

    var formattedTime: String {
        let minutes = elapsedSeconds / 60
        let seconds = elapsedSeconds % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}

// MARK: - View

struct RecordingHUDView: View {
    @ObservedObject var viewModel: RecordingHUDViewModel

    @State private var dotOpacity: Double = 1.0

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            if let failure = viewModel.failureMessage {
                // Failure state
                VIconView(.triangleAlert, size: 12)
                    .foregroundColor(VColor.systemNegativeStrong)

                Text(failure)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
                    .lineLimit(1)
            } else {
                // Recording/paused indicator dot
                Circle()
                    .fill(viewModel.isPaused ? VColor.systemNegativeHover : VColor.systemNegativeStrong)
                    .frame(width: 10, height: 10)
                    .opacity(viewModel.isPaused ? 1.0 : dotOpacity)
                    .onAppear {
                        withAnimation(
                            .easeInOut(duration: 0.8)
                            .repeatForever(autoreverses: true)
                        ) {
                            dotOpacity = 0.3
                        }
                    }

                // Elapsed time (freezes when paused via timer pause)
                Text(viewModel.formattedTime)
                    .font(VFont.monoSmall)
                    .foregroundColor(viewModel.isPaused ? VColor.contentSecondary : VColor.contentDefault)
                    .monospacedDigit()

                if viewModel.isPaused {
                    Text("Paused")
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemNegativeHover)
                }

                Spacer()

                // Pause/Resume toggle button
                Button(action: { viewModel.togglePauseResume() }) {
                    VIconView(viewModel.isPaused ? .play : .square, size: 10)
                        .foregroundColor(VColor.auxWhite)
                        .frame(width: 24, height: 24)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .fill(VColor.primaryBase)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(viewModel.isPaused ? "Resume recording" : "Pause recording")

                // Stop button
                Button(action: { viewModel.stop() }) {
                    VIconView(.square, size: 10)
                        .foregroundColor(VColor.auxWhite)
                        .frame(width: 24, height: 24)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .fill(VColor.systemNegativeStrong)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop recording")
            }
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceBase)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )
        )
        .frame(width: 220, height: 44)
    }
}
