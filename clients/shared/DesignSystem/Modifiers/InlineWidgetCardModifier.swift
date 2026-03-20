import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Standard card chrome for inline chat widgets.
/// Applies consistent padding, background, border, corner radius, and shadow
/// so all widget types (card, dynamic page, table, list) share the same visual treatment.
public struct InlineWidgetCardModifier: ViewModifier {
    let interactive: Bool
    @State private var isHovered: Bool = false

    public func body(content: Content) -> some View {
        content
            .padding(VSpacing.lg)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(VColor.surfaceOverlay)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.borderBase.opacity(0.4), lineWidth: 1)
                    .allowsHitTesting(false)
            )
            .overlay(
                Group {
                    if interactive && isHovered {
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .fill(VColor.contentEmphasized.opacity(0.03))
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.lg)
                                    .stroke(VColor.borderBase.opacity(0.3), lineWidth: 1)
                                    .blur(radius: 3)
                                    .padding(1)
                                    .mask(RoundedRectangle(cornerRadius: VRadius.lg))
                            )
                    }
                }
                .allowsHitTesting(false)
            )
            #if os(macOS)
            .onHover { hovering in
                guard interactive else { return }
                isHovered = hovering
            }
            .overlay(
                Group {
                    if interactive {
                        PointingHandCursorView()
                    }
                }
                .allowsHitTesting(false)
            )
            #endif
            .animation(VAnimation.fast, value: isHovered)
    }
}

#if os(macOS)
/// An NSView that sets the cursor to pointingHand over its entire bounds
/// using `addCursorRect`, which takes priority over SwiftUI Button cursor resets.
private struct PointingHandCursorView: NSViewRepresentable {
    func makeNSView(context: Context) -> PointingHandNSView {
        PointingHandNSView()
    }

    func updateNSView(_ nsView: PointingHandNSView, context: Context) {
        nsView.resetCursorRects()
    }
}

private class PointingHandNSView: NSView {
    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }
}
#endif

public extension View {
    func inlineWidgetCard(interactive: Bool = false) -> some View {
        modifier(InlineWidgetCardModifier(interactive: interactive))
    }
}
