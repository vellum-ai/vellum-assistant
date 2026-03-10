import AppKit
import SwiftUI
import os
import VellumAssistantShared

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "WakeWordActivationIndicator")

/// The current state of the wake word indicator overlay.
enum WakeWordIndicatorState {
    /// Wake word detected, voice mode is activating.
    case activated
    /// Voice mode ended, returning to passive wake word listening.
    case listening
}

/// A floating NSPanel that displays a small indicator pill in the top-right
/// area of the screen when the wake word is detected or the app returns to
/// passive listening. Uses AppKit + design system tokens to match the
/// the app's overlay style and respect light/dark mode.
@MainActor
final class WakeWordActivationWindow {
    private var panel: NSPanel?
    private var dismissTask: Task<Void, Never>?

    private let panelWidth: CGFloat = 240
    private let panelHeight: CGFloat = 36
    private let margin: CGFloat = 16

    /// Show the activation indicator for a given state.
    /// Auto-dismisses after the specified duration.
    func show(state: WakeWordIndicatorState, dismissAfter: TimeInterval = 1.5) {
        close()

        let contentView = buildContentView(state: state)

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.contentView = contentView
        panel.isMovableByWindowBackground = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]

        // Position top-right, slightly below where VoiceTranscriptionWindow appears
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.maxX - panelWidth - margin
            let y = screenFrame.maxY - panelHeight - margin
            panel.setFrameOrigin(NSPoint(x: x, y: y))
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
        panel?.orderOut(nil)
        panel = nil
    }

    // MARK: - AppKit Content

    private func buildContentView(state: WakeWordIndicatorState) -> NSView {
        let container = WakeWordOverlayBackgroundView()
        container.wantsLayer = true

        let dot = makeDot(for: state)
        let label = makeLabel(for: state)

        dot.translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false

        container.addSubview(dot)
        container.addSubview(label)

        NSLayoutConstraint.activate([
            dot.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
            dot.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8),

            label.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 8),
            label.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -16),
            label.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])

        return container
    }

    private func makeDot(for state: WakeWordIndicatorState) -> NSView {
        let dot = NSView(frame: NSRect(x: 0, y: 0, width: 8, height: 8))
        dot.wantsLayer = true
        let color: Color = state == .activated ? VColor.accent : VColor.success
        dot.layer?.backgroundColor = NSColor(color).cgColor
        dot.layer?.cornerRadius = 4
        return dot
    }

    private func makeLabel(for state: WakeWordIndicatorState) -> NSTextField {
        let text: String
        switch state {
        case .activated:
            text = "Activated"
        case .listening:
            let keyword = UserDefaults.standard.string(forKey: "wakeWordKeyword") ?? "computer"
            text = "Listening for \u{201C}\(keyword)\u{201D}"
        }

        let field = NSTextField(labelWithString: text)
        field.font = NSFont(name: "Inter", size: 11) ?? NSFont.systemFont(ofSize: 11)
        field.textColor = NSColor(VColor.textSecondary)
        field.lineBreakMode = .byTruncatingTail
        field.maximumNumberOfLines = 1
        return field
    }
}

/// Rounded, semi-transparent background using design system tokens.
private class WakeWordOverlayBackgroundView: NSView {
    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = NSColor(VColor.surface).withAlphaComponent(0.95).cgColor
        layer?.cornerRadius = VRadius.lg
        layer?.borderWidth = 1
        layer?.borderColor = NSColor(VColor.surfaceBorder).cgColor
    }
}

#Preview("Activated") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: VSpacing.sm) {
            Circle()
                .fill(VColor.accent)
                .frame(width: 8, height: 8)
            Text("Activated")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.surface.opacity(0.95))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
    }
    .frame(width: 300, height: 80)
}

#Preview("Listening") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: VSpacing.sm) {
            Circle()
                .fill(VColor.success)
                .frame(width: 8, height: 8)
            Text("Listening for \u{201C}computer\u{201D}")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.surface.opacity(0.95))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
    }
    .frame(width: 300, height: 80)
}
