@preconcurrency import AppKit
import SwiftUI

/// Strips rich text formatting (RTF/HTML with embedded theme colors) from the
/// pasteboard after a text selection copy, ensuring pasted text uses the
/// destination app's default colors instead of our dark-mode palette.
///
/// When `.textSelection(.enabled)` copies text, SwiftUI embeds resolved
/// foreground colors into RTF pasteboard data. In dark mode these are
/// green-tinted Forest/Moss palette colors that render poorly on light
/// backgrounds in external apps. This modifier intercepts Cmd+C, lets
/// SwiftUI's copy complete, then replaces the pasteboard contents with
/// plain text only.
struct PlainTextCopyModifier: ViewModifier {
    @State private var eventMonitor: Any?
    @State private var lastChangeCount: Int = NSPasteboard.general.changeCount

    func body(content: Content) -> some View {
        content
            .onAppear {
                lastChangeCount = NSPasteboard.general.changeCount
                eventMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                    if event.modifierFlags.contains(.command),
                       event.charactersIgnoringModifiers == "c" {
                        // Delay to let SwiftUI's text selection copy complete first
                        DispatchQueue.main.async {
                            sanitizePasteboard()
                        }
                    }
                    return event
                }
            }
            .onDisappear {
                if let monitor = eventMonitor {
                    NSEvent.removeMonitor(monitor)
                    eventMonitor = nil
                }
            }
    }

    private func sanitizePasteboard() {
        let pb = NSPasteboard.general
        // Only act if the pasteboard changed (a copy actually happened)
        guard pb.changeCount != lastChangeCount else { return }
        lastChangeCount = pb.changeCount

        // Only strip if RTF or HTML is present (rich text copy from text selection)
        guard pb.data(forType: .rtf) != nil || pb.data(forType: .html) != nil else { return }

        guard let plainText = pb.string(forType: .string) else { return }
        pb.clearContents()
        pb.setString(plainText, forType: .string)
    }
}

extension View {
    /// Strips RTF/HTML color attributes from the pasteboard after text selection
    /// copy (Cmd+C), keeping only plain text. Prevents dark-mode theme colors
    /// from appearing when pasting into external apps.
    func plainTextCopy() -> some View {
        modifier(PlainTextCopyModifier())
    }
}
