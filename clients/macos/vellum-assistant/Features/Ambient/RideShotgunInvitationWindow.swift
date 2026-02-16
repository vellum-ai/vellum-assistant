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
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 260),
            styleMask: [.titled, .nonactivatingPanel, .utilityWindow],
            backing: .buffered,
            defer: false
        )

        panel.contentViewController = hostingController
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]

        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.maxX - 300 - 20
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
    @State private var selectedDuration: Int = 180

    private let durations: [(label: String, seconds: Int)] = [
        ("1 min", 60),
        ("3 min", 180),
        ("5 min", 300),
    ]

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            // Icon + title
            VStack(spacing: VSpacing.sm) {
                Image(systemName: "binoculars.fill")
                    .font(.system(size: 28, weight: .light))
                    .foregroundStyle(VColor.accent)

                Text("Ride Shotgun")
                    .font(VFont.headline)
                    .foregroundStyle(VColor.textPrimary)

                Text("I'll observe your screen briefly\nto learn how I can help.")
                    .font(VFont.caption)
                    .foregroundStyle(VColor.textMuted)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
            }

            // Duration
            Picker("Duration", selection: $selectedDuration) {
                ForEach(durations, id: \.seconds) { option in
                    Text(option.label).tag(option.seconds)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            // Actions
            HStack(spacing: VSpacing.sm) {
                Button {
                    onDecline()
                } label: {
                    Text("Not now")
                        .font(VFont.body)
                        .foregroundStyle(VColor.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, VSpacing.sm)
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.escape, modifiers: [])

                Button {
                    onAccept(selectedDuration)
                } label: {
                    Text("Let's go")
                        .font(VFont.bodyMedium)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, VSpacing.sm)
                        .background(VColor.accent)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.return, modifiers: [])
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 280)
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .stroke(VColor.surfaceBorder, lineWidth: 0.5)
        )
        .vShadow(VShadow.lg)
    }
}
