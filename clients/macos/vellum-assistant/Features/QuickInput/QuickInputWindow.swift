import AppKit
import SwiftUI
import VellumAssistantShared

/// Borderless NSPanel subclass that can become key window.
/// Without this override, borderless windows refuse key status
/// and SwiftUI TextField won't accept keyboard input.
private class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// Observable model that lets QuickInputWindow inject text (e.g. from voice)
/// into the SwiftUI QuickInputView's text field.
@MainActor
@Observable
final class QuickInputTextModel {
    var text = ""
    var isRecording = false
    /// When set, the user has selected an existing conversation to continue.
    var selectedConversationId: UUID?
    var selectedConversationTitle: String?
}

/// A borderless, floating NSPanel that hosts the Quick Input text field.
/// Appears centered on the active screen, slightly above center (Spotlight-style).
/// Dismisses itself when it resigns key window status.
@MainActor
final class QuickInputWindow {
    private var panel: NSPanel?
    private var resignObserver: Any?
    private var previousApp: NSRunningApplication?
    private var isDismissing = false
    private var isCapturingScreen = false

    /// Attached screenshot data (JPEG) from screen region capture.
    private(set) var attachedImageData: Data?
    /// Attached screenshot image for display in the chip.
    private(set) var attachedImage: NSImage?

    /// Callback invoked when the user submits a message to a new chat.
    /// Includes optional image data from a screen capture.
    var onSubmit: ((String, Data?) -> Void)?
    /// Callback invoked when the user submits a message to an existing conversation.
    var onSubmitToConversation: ((String, Data?) -> Void)?
    /// Callback invoked when the user taps the microphone button.
    var onMicrophoneToggle: (() -> Void)?
    /// Callback invoked when the user selects an existing conversation (navigates to it).
    var onSelectConversation: ((UUID) -> Void)?
    /// Recent conversations to show in the dropdown.
    var recentConversations: [QuickInputConversation] = []
    /// When true, show a screen recording permission prompt below the bar.
    var showScreenPermissionPrompt = false

    /// Shared text model for voice input injection.
    private let textModel = QuickInputTextModel()
    private var screenSelectionWindow: ScreenSelectionWindow?

    func show() {
        let panel = makePanel()
        centerOnScreen(panel)
        presentPanel(panel)
    }

    func showAboveDock() {
        let panel = makePanel()
        positionAboveDock(panel)
        presentPanel(panel)
    }

    /// Shows the panel positioned near the bottom-right of the given screen rect.
    func showNearRect(_ rect: NSRect) {
        let panel = makePanel()
        repositionNearRect(panel, rect: rect)
        presentPanel(panel)
    }

    /// Sets the attached screenshot before the panel is shown.
    func setAttachment(imageData: Data) {
        attachedImageData = imageData
        attachedImage = NSImage(data: imageData)
    }

    // MARK: - Screen Selection

    func startScreenSelection() {

        isCapturingScreen = true

        // Remove the resign-key observer so the panel doesn't dismiss when the
        // selection overlay takes key status. The panel stays visible — the
        // screenshot excludes app windows via SCContentFilter, and the selection
        // overlay renders above the panel (.screenSaver > .floating).
        if let resignObserver {
            NotificationCenter.default.removeObserver(resignObserver)
        }
        resignObserver = nil

        // Save the panel's current frame so we can restore it after recreating
        // the panel (needed because attachedImage is a `let` init param).
        let savedFrame = self.panel?.frame

        let selectionWindow = ScreenSelectionWindow()
        selectionWindow.onComplete = { [weak self] imageData, selectionRect in
            guard let self else { return }
            self.attachedImageData = imageData
            self.attachedImage = NSImage(data: imageData)
            self.screenSelectionWindow = nil
            self.isCapturingScreen = false

            // Recreate the panel with the image attached
            self.panel?.close()
            self.panel = nil
            let newPanel = self.makePanel()
            // Restore to the saved position instead of repositioning near the selection rect
            if let savedFrame {
                newPanel.setFrame(savedFrame, display: true)
            } else {
                self.repositionNearRect(newPanel, rect: selectionRect)
            }
            self.presentPanel(newPanel)
        }
        selectionWindow.onCancel = { [weak self] in
            guard let self else { return }
            self.screenSelectionWindow = nil
            self.isCapturingScreen = false

            // Panel was never hidden — just restore the resign-key observer
            self.resignObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.didResignKeyNotification,
                object: self.panel,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    guard self?.isCapturingScreen != true else { return }
                    self?.dismiss(restorePreviousApp: false)
                }
            }
        }
        selectionWindow.show()
        self.screenSelectionWindow = selectionWindow
    }

    // MARK: - Panel Creation & Presentation

    private func makePanel() -> NSPanel {
        // Remember the frontmost app so we can restore focus on dismiss.
        // Only capture on first invocation — panel recreation (e.g. after
        // screenshot capture) happens while Vellum is frontmost, so
        // overwriting would lose the original app reference.
        if previousApp == nil {
            previousApp = NSWorkspace.shared.frontmostApplication
        }

        if let existing = panel {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return existing
        }

        textModel.text = ""
        let view = QuickInputView(
            textModel: textModel,
            onSubmit: { [weak self] message in
                if let conversationId = self?.textModel.selectedConversationId {
                    self?.onSelectConversation?(conversationId)
                    // Small delay so the conversation switches before we send the message
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        self?.onSubmitToConversation?(message, self?.attachedImageData)
                    }
                } else {
                    self?.onSubmit?(message, self?.attachedImageData)
                }
                self?.dismiss(restorePreviousApp: true)
            },
            onDismiss: { [weak self] in
                self?.dismiss()
            },
            onSelectConversation: { [weak self] conversationId, conversationTitle in
                self?.textModel.selectedConversationId = conversationId
                self?.textModel.selectedConversationTitle = conversationTitle
            },
            onScreenCapture: { [weak self] in
                self?.startScreenSelection()
            },
            onRemoveAttachment: { [weak self] in
                self?.removeAttachment()
            },
            onAllowScreenRecording: { [weak self] in
                PermissionManager.requestScreenRecordingAccess()
                self?.dismiss()
            },
            onMicrophoneToggle: onMicrophoneToggle,
            recentConversations: recentConversations,
            attachedImage: attachedImage,
            showScreenPermissionPrompt: showScreenPermissionPrompt
        )

        let hostingController = NSHostingController(rootView: view)

        let newPanel = KeyablePanel(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 56),
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
        // Animate in
        panel.alphaValue = 0
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        NSAnimationContext.runAnimationGroup { context in
            context.duration = VAnimation.durationFast
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }

        // Dismiss when the panel loses focus. Don't restore the previous
        // app — the user clicked elsewhere, so that app already has focus.
        resignObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                // Don't dismiss while screen capture is in progress
                guard self?.isCapturingScreen != true else { return }
                self?.dismiss(restorePreviousApp: false)
            }
        }

        self.panel = panel
    }

    func dismiss(restorePreviousApp: Bool = true) {
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

        let appToRestore = restorePreviousApp ? previousApp : nil
        previousApp = nil

        NSAnimationContext.runAnimationGroup({ context in
            context.duration = VAnimation.durationFast
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            MainActor.assumeIsolated {
                panel.close()
                self?.panel = nil
                self?.isDismissing = false
                self?.attachedImageData = nil
                self?.attachedImage = nil
                appToRestore?.activate()
            }
        })
    }

    var isVisible: Bool {
        panel?.isVisible ?? false
    }

    /// Sets the text field content from voice transcription.
    func setVoiceText(_ text: String) {
        textModel.text = text
    }

    /// Updates the recording state indicator in the quick input bar.
    func setRecordingState(_ isRecording: Bool) {
        textModel.isRecording = isRecording
    }

    // MARK: - Attachment Management

    private func removeAttachment() {
        attachedImageData = nil
        attachedImage = nil

        // Recreate the panel without the image chip
        guard let existingPanel = panel else { return }
        let frame = existingPanel.frame
        existingPanel.close()
        panel = nil
        let newPanel = makePanel()
        newPanel.setFrame(frame, display: true)
        presentPanel(newPanel)
    }

    // MARK: - Positioning

    /// Positions the panel near the bottom-right of the selection rectangle.
    private func repositionNearRect(_ panel: NSPanel, rect: NSRect) {
        let panelWidth = max(panel.contentView?.fittingSize.width ?? 720, 720)
        let panelHeight = panel.contentView?.fittingSize.height ?? 56

        // Place below the selection, aligned with its right edge
        var x = rect.maxX - panelWidth
        var y = rect.minY - panelHeight - 12

        // Clamp to screen bounds
        let mouseLocation = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { $0.frame.contains(mouseLocation) })
            ?? NSScreen.main
            ?? NSScreen.screens.first
        if let visibleFrame = screen?.visibleFrame {
            x = max(visibleFrame.minX + 8, min(x, visibleFrame.maxX - panelWidth - 8))
            y = max(visibleFrame.minY + 8, min(y, visibleFrame.maxY - panelHeight - 8))
        }

        panel.setFrame(NSRect(x: x, y: y, width: panelWidth, height: panelHeight), display: true)
    }

    private func positionAboveDock(_ panel: NSPanel) {
        let mouseLocation = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { $0.frame.contains(mouseLocation) })
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let screen else { panel.center(); return }

        let visibleFrame = screen.visibleFrame
        let panelWidth = max(panel.contentView?.fittingSize.width ?? 720, 720)
        let panelHeight = panel.contentView?.fittingSize.height ?? 48
        let x = visibleFrame.midX - panelWidth / 2
        // visibleFrame.minY is the top of the Dock; place the panel just above it
        let y = visibleFrame.minY + 8
        panel.setFrame(NSRect(x: x, y: y, width: panelWidth, height: panelHeight), display: true)
    }

    private func centerOnScreen(_ panel: NSPanel) {
        // Use the screen containing the mouse cursor so the panel appears
        // on the active display, even when triggered from another app.
        let mouseLocation = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { $0.frame.contains(mouseLocation) })
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let screenFrame = screen?.visibleFrame else { return }

        if let fittingSize = panel.contentView?.fittingSize {
            let width = max(fittingSize.width, 500)
            let height = fittingSize.height
            let x = screenFrame.midX - width / 2
            // Position ~1/3 from top (like Spotlight)
            let y = screenFrame.midY + screenFrame.height * 0.15
            panel.setFrame(
                NSRect(x: x, y: y, width: width, height: height),
                display: true
            )
        } else {
            panel.center()
        }
    }
}
