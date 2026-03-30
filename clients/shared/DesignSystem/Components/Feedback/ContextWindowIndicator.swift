import SwiftUI

/// A small circular ring indicator showing context window fill level.
/// Designed to sit in the composer toolbar area. On hover, shows a rich
/// popover with percentage, token counts, and compaction note.
/// Hidden when `fillRatio` is nil (no usage data yet).
public struct ContextWindowIndicator: View {
    public let fillRatio: Double?
    public let tokensUsed: Int?
    public let tokensMax: Int?

    public init(fillRatio: Double?, tokensUsed: Int? = nil, tokensMax: Int? = nil) {
        self.fillRatio = fillRatio
        self.tokensUsed = tokensUsed
        self.tokensMax = tokensMax
    }

    @State private var isHovered = false

    private let ringSize: CGFloat = 16
    private let ringLineWidth: CGFloat = 2

    private var ringColor: Color {
        guard let ratio = fillRatio else { return .clear }
        if ratio >= 0.8 { return VColor.systemNegativeStrong }
        if ratio >= 0.6 { return VColor.systemMidStrong }
        return VColor.contentTertiary
    }

    private var percentText: String {
        guard let ratio = fillRatio else { return "0%" }
        return "\(Int(ratio * 100))%"
    }

    /// Formats a token count as "148k" style.
    private static func formatTokens(_ count: Int) -> String {
        if count >= 1000 {
            return "\(count / 1000)k"
        }
        return "\(count)"
    }

    public var body: some View {
        if let ratio = fillRatio, ratio > 0 {
            circularRing(ratio: ratio)
                .onHover { hovering in
                    isHovered = hovering
                }
                .popover(isPresented: $isHovered, arrowEdge: .top) {
                    popoverContent
                }
                .accessibilityLabel("Context window \(Int((fillRatio ?? 0) * 100)) percent used")
        }
    }

    @ViewBuilder
    private func circularRing(ratio: Double) -> some View {
        ZStack {
            // Track ring
            Circle()
                .stroke(VColor.contentTertiary.opacity(0.2), lineWidth: ringLineWidth)
                .frame(width: ringSize, height: ringSize)

            // Fill ring
            Circle()
                .trim(from: 0, to: CGFloat(min(ratio, 1.0)))
                .stroke(ringColor, style: StrokeStyle(lineWidth: ringLineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .frame(width: ringSize, height: ringSize)
        }
        .frame(width: ringSize, height: ringSize)
    }

    @ViewBuilder
    private var popoverContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Context window:")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)

            Text("\(percentText) full")
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(ringColor)

            if let used = tokensUsed, let max = tokensMax {
                Text("\(Self.formatTokens(used)) / \(Self.formatTokens(max)) tokens used")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }

            Text("Vellum automatically\ncompacts its context.")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .padding(VSpacing.md)
    }
}
