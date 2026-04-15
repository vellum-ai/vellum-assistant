import VellumAssistantShared
import AppKit
import SwiftUI

struct VoiceTranscriptionView: View {
    @State private var appearance = AvatarAppearanceManager.shared
    @ObservedObject var voiceModeManager: VoiceModeManager

    private let circleSize: CGFloat = 80

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle()
                    .stroke(VColor.primaryBase, lineWidth: 2.5)
                    .frame(width: circleSize, height: circleSize)

                VAvatarImage(image: appearance.chatAvatarImage, size: circleSize - 8, showBorder: false)
            }

            Text(voiceModeManager.stateLabel.isEmpty ? "Listening" : voiceModeManager.stateLabel)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)

            if !voiceModeManager.liveTranscription.isEmpty {
                Text(voiceModeManager.liveTranscription)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(3)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 260)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .frame(minWidth: 140)
        .vPanelBackground()
    }
}

@MainActor
final class VoiceTranscriptionWindow {
    private var panel: NSPanel?
    private weak var voiceModeManager: VoiceModeManager?

    private let baseWidth: CGFloat = 140
    private let baseHeight: CGFloat = 140
    private let margin: CGFloat = 16

    init(voiceModeManager: VoiceModeManager) {
        self.voiceModeManager = voiceModeManager
    }

    func show() {
        guard let manager = voiceModeManager else { return }

        let rootView = VoiceTranscriptionView(voiceModeManager: manager)
        let hostingController = NSHostingController(rootView: rootView)

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: baseWidth, height: baseHeight),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        panel.contentViewController = hostingController
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hasShadow = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]

        // Position top-right corner of screen
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.maxX - baseWidth - margin
            let y = screenFrame.maxY - baseHeight - margin
            panel.setFrame(NSRect(x: x, y: y, width: baseWidth, height: baseHeight), display: false)
        }

        panel.orderFront(nil)
        self.panel = panel
    }

    func close() {
        panel?.close()
        panel = nil
    }
}
