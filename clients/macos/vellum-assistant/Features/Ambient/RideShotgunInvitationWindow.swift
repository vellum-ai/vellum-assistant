import VellumAssistantShared
import AppKit
import SwiftUI

final class RideShotgunInvitationWindow {
    private var panel: NSPanel?
    private let onAccept: (Int) -> Void  // durationSeconds
    private let onDecline: () -> Void

    init(onAccept: @escaping (Int) -> Void, onDecline: @escaping () -> Void) {
        self.onAccept = onAccept
        self.onDecline = onDecline
    }

    func show() {
        let view = RideShotgunInvitationView(
            onAccept: { [weak self] duration in
                self?.close()
                self?.onAccept(duration)
            },
            onDecline: { [weak self] in
                self?.close()
                self?.onDecline()
            }
        )
        let hostingController = NSHostingController(rootView: view)

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 320),
            styleMask: [.titled, .nonactivatingPanel, .utilityWindow, .hudWindow],
            backing: .buffered,
            defer: false
        )

        panel.contentViewController = hostingController
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.alphaValue = 0.95
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]

        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.maxX - 380 - 20
            let y = screenFrame.minY + 20
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        panel.orderFront(nil)
        self.panel = panel
    }

    func close() {
        panel?.close()
        panel = nil
    }
}

private struct RideShotgunInvitationView: View {
    let onAccept: (Int) -> Void
    let onDecline: () -> Void
    @State private var selectedDuration: Int = 180 // 3 minutes default

    private let durations: [(label: String, seconds: Int)] = [
        ("1 min", 60),
        ("3 min", 180),
        ("5 min", 300),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            HStack {
                Image(systemName: "binoculars.fill")
                    .foregroundStyle(VColor.accent)
                    .font(.title2)
                Text("Ride Shotgun?")
                    .font(VFont.headline)
                Spacer()
            }

            Text("I'll watch how you work for a few minutes to understand how I can help.")
                .font(VFont.body)
                .foregroundStyle(VColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            // AX preview placeholder
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("What I can see:")
                    .font(VFont.caption)
                    .foregroundStyle(VColor.textMuted)
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.surface)
                    .frame(height: 60)
                    .overlay(
                        Text("Screen content preview")
                            .font(VFont.caption)
                            .foregroundStyle(VColor.textMuted)
                    )
            }

            // Duration picker
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Duration")
                    .font(VFont.caption)
                    .foregroundStyle(VColor.textMuted)
                HStack(spacing: VSpacing.sm) {
                    ForEach(durations, id: \.seconds) { option in
                        Button(option.label) {
                            selectedDuration = option.seconds
                        }
                        .buttonStyle(.bordered)
                        .tint(selectedDuration == option.seconds ? VColor.accent : nil)
                    }
                }
            }

            HStack {
                Spacer()
                Button("Not now") {
                    onDecline()
                }
                .keyboardShortcut(.escape, modifiers: [])

                Button("Let's ride") {
                    onAccept(selectedDuration)
                }
                .keyboardShortcut(.return, modifiers: [])
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .frame(width: 380)
        .vPanelBackground()
    }
}
