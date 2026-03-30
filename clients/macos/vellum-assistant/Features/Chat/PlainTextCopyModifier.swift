@preconcurrency import AppKit
import SwiftUI

/// Singleton that manages a single app-wide keyDown event monitor for
/// stripping rich text formatting from the pasteboard after Cmd+C.
///
/// When `.textSelection(.enabled)` copies text, SwiftUI embeds resolved
/// foreground colors into RTF pasteboard data. In dark mode these are
/// green-tinted Forest/Moss palette colors that render poorly on light
/// backgrounds in external apps. This class intercepts Cmd+C, lets
/// SwiftUI's copy complete, then replaces the pasteboard contents with
/// plain text only.
///
/// Uses reference counting so multiple `.plainTextCopy()` view modifiers
/// share a single monitor. The monitor is installed when the first view
/// appears and removed when the last view disappears.
@MainActor
final class PasteboardSanitizer {
    static let shared = PasteboardSanitizer()

    private var eventMonitor: Any?
    private var refCount = 0

    private init() {}

    /// Increments the reference count and installs the event monitor if
    /// it is not already installed. Safe to call multiple times — only
    /// one monitor is ever active.
    func install() {
        refCount += 1
        guard eventMonitor == nil else { return }
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.modifierFlags.contains(.command),
               event.charactersIgnoringModifiers == "c" {
                // Snapshot the change count before SwiftUI processes the copy
                let preEventCount = NSPasteboard.general.changeCount
                // Delay to let SwiftUI's text selection copy complete first
                DispatchQueue.main.async {
                    self?.sanitizePasteboard(preEventCount: preEventCount)
                }
            }
            return event
        }
    }

    /// Decrements the reference count and removes the event monitor when
    /// no views are using it. Also guards against double-`onAppear`
    /// without an intervening `onDisappear` by clamping refCount to 0.
    func uninstall() {
        refCount -= 1
        guard refCount <= 0 else { return }
        refCount = 0
        if let monitor = eventMonitor {
            NSEvent.removeMonitor(monitor)
            eventMonitor = nil
        }
    }

    /// Strips RTF/HTML from the pasteboard if a copy actually occurred
    /// during this Cmd+C event. Compares against the pre-event change
    /// count to avoid corrupting clipboard content from other apps.
    private func sanitizePasteboard(preEventCount: Int) {
        let pb = NSPasteboard.general
        // Only act if the pasteboard changed since the key event fired,
        // confirming that this Cmd+C actually produced a new copy
        guard pb.changeCount > preEventCount else { return }

        // Only strip if RTF or HTML is present (rich text copy from text selection)
        guard pb.data(forType: .rtf) != nil || pb.data(forType: .html) != nil else { return }

        guard let plainText = pb.string(forType: .string) else { return }
        pb.clearContents()
        pb.setString(plainText, forType: .string)
    }
}

/// View modifier that participates in `PasteboardSanitizer`'s
/// reference-counted singleton monitor. Apply once at a container level
/// (e.g. the chat message list) rather than per-message to avoid O(N)
/// monitors.
struct PlainTextCopyModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .onAppear { PasteboardSanitizer.shared.install() }
            .onDisappear { PasteboardSanitizer.shared.uninstall() }
    }
}

extension View {
    /// Strips RTF/HTML color attributes from the pasteboard after text selection
    /// copy (Cmd+C), keeping only plain text. Prevents dark-mode theme colors
    /// from appearing when pasting into external apps.
    ///
    /// Uses a singleton event monitor — safe to call from multiple views without
    /// creating duplicate monitors.
    func plainTextCopy() -> some View {
        modifier(PlainTextCopyModifier())
    }

    /// Conditionally applies `.textSelection(.enabled)` or `.textSelection(.disabled)`.
    ///
    /// `EnabledTextSelectability` and `DisabledTextSelectability` are different
    /// concrete types conforming to `TextSelectability`, so a ternary expression
    /// cannot return both. This extension uses `@ViewBuilder` branching instead.
    ///
    /// - SeeAlso: https://developer.apple.com/documentation/swiftui/textselectability
    @ViewBuilder
    func textSelection(enabled: Bool) -> some View {
        if enabled {
            self.textSelection(.enabled)
        } else {
            self.textSelection(.disabled)
        }
    }
}
