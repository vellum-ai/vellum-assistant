import VellumAssistantShared
import AppKit
import SwiftUI

struct VoiceTranscriptionView: View {
    @State private var appearance = AvatarAppearanceManager.shared

    private let circleSize: CGFloat = 80
    private let dinoPixelSize: CGFloat = 3

    var body: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle()
                    .stroke(VColor.accent, lineWidth: 2.5)
                    .frame(width: circleSize, height: circleSize)

                Image(nsImage: PixelSpriteBuilder.buildBlobNSImage(pixelSize: dinoPixelSize, palette: appearance.palette))
            }

            Text("Listening")
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.textPrimary)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .frame(width: 140)
        .vPanelBackground()
    }
}

@MainActor
final class VoiceTranscriptionWindow {
    private var panel: NSPanel?

    private let panelWidth: CGFloat = 140
    private let panelHeight: CGFloat = 140
    private let margin: CGFloat = 16

    func show() {
        let hostingController = NSHostingController(rootView: VoiceTranscriptionView())

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

        // Position top-right corner of screen
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.maxX - panelWidth - margin
            let y = screenFrame.maxY - panelHeight - margin
            panel.setFrame(NSRect(x: x, y: y, width: panelWidth, height: panelHeight), display: false)
        }

        panel.orderFront(nil)
        self.panel = panel
    }

    func close() {
        panel?.close()
        panel = nil
    }
}
