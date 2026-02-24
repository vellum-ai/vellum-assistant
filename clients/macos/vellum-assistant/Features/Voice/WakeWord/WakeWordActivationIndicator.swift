import VellumAssistantShared
import SwiftUI
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "WakeWordActivationIndicator")

/// The current state of the wake word indicator overlay.
enum WakeWordIndicatorState {
    /// Wake word detected, voice mode is activating.
    case activated
    /// Voice mode ended, returning to passive wake word listening.
    case listening
}

/// A small floating indicator shown briefly when the wake word is detected
/// or when the app returns to passive listening mode. Auto-dismisses after
/// a short delay as the voice mode UI takes over.
struct WakeWordActivationIndicator: View {
    let state: WakeWordIndicatorState

    @State private var isVisible = false

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)

            Text(labelText)
                .font(VFont.caption)
                .foregroundColor(VColor.textPrimary)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.background.opacity(0.92))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(borderColor, lineWidth: 1)
        )
        .opacity(isVisible ? 1 : 0)
        .scaleEffect(isVisible ? 1 : 0.85)
        .onAppear {
            withAnimation(VAnimation.fast) {
                isVisible = true
            }
        }
    }

    private var labelText: String {
        switch state {
        case .activated:
            return "Activated"
        case .listening:
            return "Listening for \u{201C}hey vellum\u{201D}"
        }
    }

    private var dotColor: Color {
        switch state {
        case .activated:
            return VColor.accent
        case .listening:
            return VColor.success
        }
    }

    private var borderColor: Color {
        switch state {
        case .activated:
            return VColor.accent.opacity(0.4)
        case .listening:
            return VColor.surfaceBorder
        }
    }
}

/// A floating NSPanel that displays the `WakeWordActivationIndicator`
/// in the top-right area of the screen, matching the placement approach
/// used by `VoiceTranscriptionWindow`.
@MainActor
final class WakeWordActivationWindow {
    private var panel: NSPanel?
    private var dismissTask: Task<Void, Never>?

    private let panelWidth: CGFloat = 220
    private let panelHeight: CGFloat = 36
    private let margin: CGFloat = 16

    /// Show the activation indicator for a given state.
    /// Auto-dismisses after the specified duration.
    func show(state: WakeWordIndicatorState, dismissAfter: TimeInterval = 1.5) {
        close()

        let hostingController = NSHostingController(
            rootView: WakeWordActivationIndicator(state: state)
        )

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight),
            styleMask: [.titled, .nonactivatingPanel, .utilityWindow, .hudWindow],
            backing: .buffered,
            defer: false
        )

        panel.contentViewController = hostingController
        panel.level = .floating
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.alphaValue = 0.95
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]
        panel.backgroundColor = .clear

        // Position top-right, slightly below where VoiceTranscriptionWindow appears
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.maxX - panelWidth - margin
            let y = screenFrame.maxY - panelHeight - margin
            panel.setFrame(
                NSRect(x: x, y: y, width: panelWidth, height: panelHeight),
                display: false
            )
        }

        panel.orderFront(nil)
        self.panel = panel

        log.debug("Showing wake word indicator: \(String(describing: state))")

        // Auto-dismiss after delay
        dismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(dismissAfter * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self.close()
        }
    }

    func close() {
        dismissTask?.cancel()
        dismissTask = nil
        panel?.close()
        panel = nil
    }
}

#Preview("Activated") {
    ZStack {
        VColor.background.ignoresSafeArea()
        WakeWordActivationIndicator(state: .activated)
    }
    .frame(width: 300, height: 80)
}

#Preview("Listening") {
    ZStack {
        VColor.background.ignoresSafeArea()
        WakeWordActivationIndicator(state: .listening)
    }
    .frame(width: 300, height: 80)
}
