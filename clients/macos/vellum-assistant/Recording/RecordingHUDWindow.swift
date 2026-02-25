import AppKit
import SwiftUI
import VellumAssistantShared

/// Recording indicator HUD that shows a red dot, elapsed time, and stop button.
///
/// Floats as a small panel in the top-right corner of the screen during
/// an active recording. Uses design system tokens for styling.
@MainActor
final class RecordingHUDWindow {
    private var panel: NSPanel?
    private var viewModel: RecordingHUDViewModel?

    /// Show the recording HUD.
    ///
    /// - Parameter onStop: Called when the user clicks the stop button.
    func show(onStop: @escaping () -> Void) {
        dismiss()

        let vm = RecordingHUDViewModel(onStop: onStop)
        self.viewModel = vm

        let hudView = RecordingHUDView(viewModel: vm)
        let hostingController = NSHostingController(rootView: hudView)

        let hudPanel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 180, height: 44),
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
            let x = screenFrame.maxX - 196
            let y = screenFrame.maxY - 60
            hudPanel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        hudPanel.orderFront(nil)
        self.panel = hudPanel
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
    @Published var failureMessage: String?

    private var timer: Timer?
    private let onStop: () -> Void

    init(onStop: @escaping () -> Void) {
        self.onStop = onStop
        startTimer()
    }

    func startTimer() {
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.elapsedSeconds += 1
            }
        }
    }

    func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    func stop() {
        stopTimer()
        onStop()
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
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(VColor.error)
                    .font(.system(size: 12))

                Text(failure)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .lineLimit(1)
            } else {
                // Recording indicator dot with pulse animation
                Circle()
                    .fill(VColor.error)
                    .frame(width: 10, height: 10)
                    .opacity(dotOpacity)
                    .onAppear {
                        withAnimation(
                            .easeInOut(duration: 0.8)
                            .repeatForever(autoreverses: true)
                        ) {
                            dotOpacity = 0.3
                        }
                    }

                // Elapsed time
                Text(viewModel.formattedTime)
                    .font(VFont.monoSmall)
                    .foregroundColor(VColor.textPrimary)
                    .monospacedDigit()

                Spacer()

                // Stop button
                Button(action: { viewModel.stop() }) {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 10))
                        .foregroundColor(.white)
                        .frame(width: 24, height: 24)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.sm)
                                .fill(VColor.error)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop recording")
            }
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )
        )
        .frame(width: 180, height: 44)
    }
}
