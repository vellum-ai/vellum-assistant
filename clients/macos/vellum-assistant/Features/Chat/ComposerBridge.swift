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

/// Minimal NSViewRepresentable that provides AppKit integration for the composer:
/// - Registers a typing-redirect handler with TitleBarZoomableWindow so
///   keystrokes auto-focus the composer when nothing else is focused.
/// - Registers the composer container view for click-away-to-blur detection.
///
/// Key routing (Return, Cmd+V image paste) is handled directly by
/// `ComposerTextView.keyDown(with:)` and `performKeyEquivalent(with:)`.
struct ComposerFocusBridge: NSViewRepresentable {
    let isFocused: Bool
    let isInteractionEnabled: Bool
    let onRedirectKeystroke: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> NSView {
        NSView(frame: .zero)
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.parent = self

        guard let window = nsView.window as? TitleBarZoomableWindow else { return }

        let coordinator = context.coordinator
        if isInteractionEnabled {
            window.composerRedirectHandler = { chars in
                coordinator.parent.onRedirectKeystroke(chars)
            }
        } else {
            window.composerRedirectHandler = nil
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
        if let window = nsView.window as? TitleBarZoomableWindow {
            window.composerRedirectHandler = nil
        }
    }

    final class Coordinator {
        var parent: ComposerFocusBridge

        init(parent: ComposerFocusBridge) {
            self.parent = parent
        }
    }
}
