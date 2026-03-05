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

// MARK: - Composer Editor Height Preference Key

/// PreferenceKey used to measure the natural height of the TextField composer
/// so that ChatView can compute the correct bottom safe-area inset.
struct ComposerEditorHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

// MARK: - Composer Focus Bridge

/// Minimal NSViewRepresentable that provides AppKit integration for the
/// SwiftUI TextField composer:
/// - Registers a typing-redirect handler with TitleBarZoomableWindow so
///   keystrokes auto-focus the composer when nothing else is focused.
/// - Registers the composer container view for click-away-to-blur detection.
/// - Intercepts Cmd+V when the pasteboard contains image content.
/// - Intercepts Cmd+Enter for send when cmdEnterToSend is enabled.
struct ComposerFocusBridge: NSViewRepresentable {
    let isFocused: Bool
    let cmdEnterToSend: Bool
    let onImagePaste: () -> Void
    let onCmdEnterSend: () -> Void
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

                // Cmd+Enter -> send (when cmdEnterToSend is enabled)
                if self.parent.cmdEnterToSend,
                   modifiers == [.command],
                   event.keyCode == 36 || event.keyCode == 76 {
                    self.parent.onCmdEnterSend()
                    return nil
                }

                // Cmd+Return or Ctrl+Return in default mode -> insert newline.
                // Option+Return inserts a newline natively on macOS;
                // Cmd/Ctrl+Return do not, so we insert one manually at
                // the cursor position via the field editor.
                if !self.parent.cmdEnterToSend,
                   (modifiers == [.command] || modifiers == [.control]),
                   event.keyCode == 36 || event.keyCode == 76 {
                    if let textView = event.window?.firstResponder as? NSTextView {
                        textView.insertNewlineIgnoringFieldEditor(nil)
                        return nil
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
    let iconSize: CGFloat
    let action: () -> Void
    @State private var isPulsing = false

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
                    .font(.system(size: iconSize, weight: .regular))
                    .foregroundColor(isRecording ? VColor.error : adaptiveColor(light: Forest._500, dark: Moss._400))
            }
        }
        .accessibilityLabel(isRecording ? "Stop recording" : "Start voice input")
        .onChange(of: isRecording) {
            isPulsing = isRecording
        }
        .onAppear {
            isPulsing = isRecording
        }
    }
}
