#if os(macOS)
import SwiftUI

/// Horizontally scrolling text that reveals truncated content on hover.
///
/// When the text fits within the available width, it renders as a normal
/// single-line truncated `Text`. When `isHovered` is `true` and the text
/// is truncated, an offset animation scrolls to reveal the full content.
///
/// Text width is calculated programmatically via `NSString.size(withAttributes:)`
/// using the provided `measuringFont`, avoiding hidden layout views and the
/// extra view-hierarchy overhead they add in list rows.
///
/// - Parameters:
///   - text: The string to display.
///   - font: SwiftUI `Font` for rendering.
///   - measuringFont: `NSFont` equivalent used for width calculation.
///   - foregroundStyle: Text color.
///   - isHovered: When `true` and the text is truncated, the scroll animation activates.
public struct VMarqueeText: View {
    let text: String
    let font: Font
    let measuringFont: NSFont
    let foregroundStyle: Color
    let isHovered: Bool

    public init(
        text: String,
        font: Font,
        measuringFont: NSFont,
        foregroundStyle: Color,
        isHovered: Bool
    ) {
        self.text = text
        self.font = font
        self.measuringFont = measuringFont
        self.foregroundStyle = foregroundStyle
        self.isHovered = isHovered
    }

    /// Points per second the text scrolls. Tuned for comfortable reading.
    private static let scrollSpeed: CGFloat = 30

    @State private var containerWidth: CGFloat = 0
    @State private var animationOffset: CGFloat = 0

    private var textWidth: CGFloat {
        ceil((text as NSString).size(withAttributes: [.font: measuringFont]).width)
    }

    private var isTruncated: Bool {
        textWidth > containerWidth + 1
    }

    private var overflow: CGFloat {
        max(0, textWidth - containerWidth)
    }

    private var scrollDuration: Double {
        Double(overflow) / Self.scrollSpeed
    }

    public var body: some View {
        Text(text)
            .font(font)
            .foregroundStyle(foregroundStyle)
            .lineLimit(1)
            .truncationMode(.tail)
            .opacity(isHovered && isTruncated ? 0 : 1)
            .overlay(alignment: .leading) {
                if isHovered && isTruncated {
                    Text(text)
                        .font(font)
                        .foregroundStyle(foregroundStyle)
                        .fixedSize(horizontal: true, vertical: false)
                        .offset(x: animationOffset)
                }
            }
            .clipped()
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.width
            } action: { newWidth in
                containerWidth = newWidth
            }
            .onChange(of: isHovered) { _, hovering in
                if hovering && isTruncated {
                    withAnimation(.linear(duration: scrollDuration)) {
                        animationOffset = -overflow
                    }
                } else {
                    withAnimation(.easeOut(duration: VAnimation.durationFast)) {
                        animationOffset = 0
                    }
                }
            }
            .onChange(of: text) { _, _ in
                animationOffset = 0
            }
            .accessibilityLabel(text)
    }
}
#endif
