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
/// - Intercepts Shift+Return in default send mode to insert a newline
///   before SwiftUI's `.onSubmit` fires.
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
                // interception (Shift+Enter newline, Cmd+Enter send).
                // Plain Enter flows through to SwiftUI's .onSubmit which
                // calls performSendAction() — the canonical send path that
                // handles slash-menu, ghost-text, and pending-confirmation.
                let isReturn = event.keyCode == 36 || event.keyCode == 76
                if isReturn {
                    switch ComposerReturnKeyRouting.resolve(
                        cmdEnterToSend: self.parent.cmdEnterToSend,
                        modifiers: modifiers
                    ) {
                    case .bridgeSend:
                        self.parent.onSend()
                        return nil
                    case .bridgeInsertNewline:
                        // Insert newline via the field editor. If the text view
                        // can't be found, still consume the event to prevent
                        // .onSubmit from firing (which would send the message).
                        let textView = (event.window?.firstResponder as? NSTextView)
                            ?? (NSApp.keyWindow?.firstResponder as? NSTextView)
                        if let textView {
                            textView.insertText("\n", replacementRange: textView.selectedRange())
                        }
                        return nil
                    case .deferToSubmit:
                        return event
                    }
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

// MARK: - Microphone Button

struct MicrophoneButton: View {
    let isRecording: Bool
    let size: CGFloat
    let action: () -> Void

    @State private var isPulsing = false
    @State private var isHovered = false
    @FocusState private var isFocused: Bool

    var body: some View {
        Button(action: action) {
            ZStack {
                if isRecording {
                    Circle()
                        .fill(VColor.error.opacity(0.2))
                        .frame(width: 30, height: 30)
                        .scaleEffect(isPulsing ? 1.3 : 1.0)
                        .opacity(isPulsing ? 0.0 : 1.0)
                        .animation(.easeInOut(duration: 1.0).repeatForever(autoreverses: false), value: isPulsing)
                }

                Image(systemName: isRecording ? "mic.fill" : "mic")
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 14, height: 14)
                    .foregroundColor(isRecording ? VColor.error : adaptiveColor(light: Forest._500, dark: Moss._400))
            }
        }
        .buttonStyle(VIconButtonStyle(isHovered: isHovered, isFocused: isFocused, size: size))
        .focused($isFocused)
        #if os(macOS)
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.set() }
            else { NSCursor.arrow.set() }
        }
        #else
        .onHover { isHovered = $0 }
        #endif
        .accessibilityLabel(isRecording ? "Stop recording" : "Start voice input")
        .onChange(of: isRecording) {
            isPulsing = isRecording
        }
        .onAppear {
            isPulsing = isRecording
        }
    }
}
