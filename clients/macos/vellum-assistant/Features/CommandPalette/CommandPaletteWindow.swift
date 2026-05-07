import AppKit
import SwiftUI
import VellumAssistantShared

/// Borderless NSPanel subclass that can become key window.
/// Without this override, borderless windows refuse key status
/// and SwiftUI TextField won't accept keyboard input.
private class CommandPalettePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// A borderless, floating NSPanel that hosts the command palette (CMD+K).
/// Appears centered on the active screen, slightly above center (Spotlight-style).
/// Dismisses itself when it resigns key window status.
@MainActor
final class CommandPaletteWindow {
    private var panel: NSPanel?
    private var resignObserver: Any?
    private var isDismissing = false
    private let viewModel = CommandPaletteViewModel()

    /// Callback invoked when the user selects a recent conversation to navigate to.
    var onSelectConversation: ((UUID) -> Void)?

    /// Callback invoked when the user selects a search result conversation (by daemon session ID).
    var onSelectSearchConversation: ((String) -> Void)?

    /// Static actions to show in the palette.
    var actions: [CommandPaletteAction] = []

    /// Recent conversations to show in the palette.
    var recentItems: [CommandPaletteRecentItem] = []

    func show() {
        let panel = makePanel()
        centerOnScreen(panel)
        presentPanel(panel)
    }

    // MARK: - Panel Creation & Presentation

    private func makePanel() -> NSPanel {
        if let existing = panel {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return existing
        }

        viewModel.reset()
        viewModel.actions = actions
        viewModel.recentItems = recentItems
        let view = CommandPaletteView(
            viewModel: viewModel,
            onDismiss: { [weak self] in
                self?.dismiss()
            },
            onSelectRecent: { [weak self] conversationId in
                self?.onSelectConversation?(conversationId)
            },
            onSelectConversation: { [weak self] convId in
                self?.onSelectSearchConversation?(convId)
            }
        )

        let hostingController = NSHostingController(rootView: view)
        hostingController.sizingOptions = [.intrinsicContentSize]
        hostingController.view.wantsLayer = true
        hostingController.view.layer?.cornerRadius = VRadius.lg
        hostingController.view.layer?.masksToBounds = true

        let newPanel = CommandPalettePanel(
            contentRect: NSRect(x: 0, y: 0, width: 600, height: 120),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        newPanel.contentViewController = hostingController
        newPanel.level = .floating
        newPanel.isMovableByWindowBackground = true
        newPanel.titleVisibility = .hidden
        newPanel.titlebarAppearsTransparent = true
        newPanel.isReleasedWhenClosed = false
        newPanel.backgroundColor = .clear
        newPanel.isOpaque = false
        newPanel.hasShadow = true
        newPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        return newPanel
    }

    private func presentPanel(_ panel: NSPanel) {
        panel.alphaValue = 0
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        NSAnimationContext.runAnimationGroup { context in
            context.duration = VAnimation.durationFast
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }

        resignObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.dismiss()
            }
        }

        self.panel = panel
    }

    func dismiss() {
        guard !isDismissing else { return }
        isDismissing = true

        if let resignObserver {
            NotificationCenter.default.removeObserver(resignObserver)
        }
        resignObserver = nil

        guard let panel else {
            isDismissing = false
            return
        }

        NSAnimationContext.runAnimationGroup({ context in
            context.duration = VAnimation.durationFast
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                panel.close()
                self?.panel = nil
                self?.isDismissing = false
            }
        })
    }

    var isVisible: Bool {
        panel?.isVisible ?? false
    }

    // MARK: - Positioning

    private func centerOnScreen(_ panel: NSPanel) {
        let mouseLocation = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { $0.frame.contains(mouseLocation) })
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let screenFrame = screen?.visibleFrame else { return }

        if let fittingSize = panel.contentView?.fittingSize {
            let width = max(fittingSize.width, 600)
            let height = fittingSize.height
            let x = screenFrame.midX - width / 2
            let y = screenFrame.midY - height / 2
            panel.setFrame(
                NSRect(x: x, y: y, width: width, height: height),
                display: true
            )
        } else {
            panel.center()
        }
    }
}
