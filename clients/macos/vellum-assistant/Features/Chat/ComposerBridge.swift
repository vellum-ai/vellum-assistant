import SwiftUI
import VellumAssistantShared
#if os(macOS)
import AppKit
#endif

// MARK: - Cmd+Enter Environment Key

struct CmdEnterToSendKey: EnvironmentKey {
    static let defaultValue: Bool = false
}

extension EnvironmentValues {
    var cmdEnterToSend: Bool {
        get { self[CmdEnterToSendKey.self] }
        set { self[CmdEnterToSendKey.self] = newValue }
    }
}

// MARK: - Composer Focus Bridge

/// Minimal NSViewRepresentable that provides AppKit integration for the
/// SwiftUI TextField composer:
/// - Registers a typing-redirect handler with TitleBarZoomableWindow so
///   keystrokes auto-focus the composer when nothing else is focused.
/// - Registers the composer container view for click-away-to-blur detection.
/// - Intercepts Cmd+V when the pasteboard contains image content.
/// - Intercepts Cmd+Return when `cmdEnterToSend` is enabled to trigger send
///   before SwiftUI's `.onSubmit` fires.
/// - Intercepts Shift+Return in default send mode to insert a newline, and
///   routes default-mode Option+Return through the same bridge send path used
///   by Cmd+Return, before SwiftUI's `.onSubmit` fires.
struct ComposerFocusBridge: NSViewRepresentable {
    let isFocused: Bool
    let cmdEnterToSend: Bool
    let onImagePaste: () -> Void
    let onSend: () -> Void
    let onRedirectKeystroke: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        context.coordinator.setupEventMonitor()
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.parent = self

        guard let window = nsView.window as? TitleBarZoomableWindow else { return }

        // Register a typing-redirect handler so keystrokes auto-focus the composer.
        let coordinator = context.coordinator
        window.composerRedirectHandler = { chars in
            coordinator.parent.onRedirectKeystroke(chars)
        }

        // Walk up from the bridge view to find the composer container —
        // the first ancestor whose frame is wider, encompassing the sibling
        // action buttons. Re-evaluated on each update because layout can
        // change (compact vs expanded).
        var container: NSView = nsView
        var candidate = nsView.superview
        while let view = candidate, view !== window.contentView {
            if view.frame.width > nsView.frame.width + 20 {
                container = view
                break
            }
            candidate = view.superview
        }
        window.composerContainerView = container

        // Prevent the internal NSTextView from intercepting file drops.
        // SwiftUI's TextField wraps an NSTextView that registers for file URL
        // drag types by default, causing it to insert file paths as text.
        // Re-register with only text types so file drops fall through to the
        // SwiftUI .onDrop handler on the parent ScrollView.
        Self.unregisterFileDragTypes(in: container)
    }

    private static func unregisterFileDragTypes(in view: NSView) {
        if view is NSTextView {
            view.registerForDraggedTypes([.string, .rtf, .rtfd])
        }
        for subview in view.subviews {
            unregisterFileDragTypes(in: subview)
        }
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        coordinator.removeEventMonitor()
        if let window = nsView.window as? TitleBarZoomableWindow {
            window.composerRedirectHandler = nil
        }
    }

    final class Coordinator {
        var parent: ComposerFocusBridge
        var eventMonitor: Any?

        init(parent: ComposerFocusBridge) {
            self.parent = parent
        }

        func setupEventMonitor() {
            eventMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, self.parent.isFocused else { return event }

                let modifiers = event.modifierFlags.intersection([.shift, .command, .control, .option])

                // Cmd+V with image content -> intercept paste
                if modifiers == [.command],
                   event.charactersIgnoringModifiers?.lowercased() == "v",
                   Self.pasteboardHasImageContent() {
                    self.parent.onImagePaste()
                    return nil
                }

                // Return-key routing. The bridge handles modifier-specific
                // interception for its dedicated paths: Shift+Enter newline in
                // default mode, Option+Enter send in default mode, and
                // Cmd+Enter send when the preference is enabled.
                // Plain Enter flows through to SwiftUI's .onSubmit which
                // calls performSendAction() — the canonical send path that
                // handles slash-menu selection and pending-confirmation.
                let isReturn = event.keyCode == 36 || event.keyCode == 76
                if isReturn {
                    let action = ComposerReturnKeyRouting.resolve(
                        cmdEnterToSend: self.parent.cmdEnterToSend,
                        modifiers: modifiers
                    )
                    let textView = (event.window?.firstResponder as? NSTextView)
                        ?? (NSApp.keyWindow?.firstResponder as? NSTextView)

                    // Still consume newline routes when the field editor is
                    // missing so SwiftUI cannot accidentally treat them as send.
                    if ComposerReturnKeyRouting.performBridgeAction(
                        action,
                        textView: textView,
                        onSend: self.parent.onSend
                    ) {
                        return nil
                    }
                    return event
                }

                // Let zoom shortcuts propagate instead of being consumed
                if modifiers == [.command] || modifiers == [.command, .option] {
                    let key = event.charactersIgnoringModifiers ?? ""
                    if key == "=" || key == "+" || key == "-" || key == "0" {
                        return event
                    }
                }

                return event
            }
        }

        func removeEventMonitor() {
            if let monitor = eventMonitor {
                NSEvent.removeMonitor(monitor)
                eventMonitor = nil
            }
        }

        static func pasteboardHasImageContent() -> Bool {
            let pasteboard = NSPasteboard.general
            let hasImageFile = (pasteboard.readObjects(forClasses: [NSURL.self], options: [
                .urlReadingFileURLsOnly: true,
            ]) as? [URL])?.contains { url in
                let ext = url.pathExtension.lowercased()
                return ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "bmp"].contains(ext)
            } ?? false
            let hasImageData = pasteboard.data(forType: .png) != nil || pasteboard.data(forType: .tiff) != nil
            return hasImageFile || hasImageData
        }
    }
}

