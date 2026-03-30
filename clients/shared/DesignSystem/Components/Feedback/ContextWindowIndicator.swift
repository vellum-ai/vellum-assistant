import SwiftUI

/// A 2px-tall progress bar showing context window fill level.
/// Hidden when `fillRatio` is nil (no usage data yet).
public struct ContextWindowIndicator: View {
    public let fillRatio: Double?

    public init(fillRatio: Double?) {
        self.fillRatio = fillRatio
    }

    private var barColor: Color {
        guard let ratio = fillRatio else { return .clear }
        if ratio >= 0.8 { return VColor.systemNegativeStrong }
        if ratio >= 0.6 { return VColor.systemMidStrong }
        return VColor.contentTertiary
    }

    public var body: some View {
        if let ratio = fillRatio, ratio > 0 {
            GeometryReader { geo in
                Rectangle()
                    .fill(barColor.opacity(0.7))
                    .frame(width: geo.size.width * ratio, height: 2)
            }
            .frame(height: 2)
            .background(VColor.borderDisabled.opacity(0.2))
            .help("Context: \(Int((fillRatio ?? 0) * 100))% used")
            .accessibilityLabel("Context window \(Int((fillRatio ?? 0) * 100)) percent used")
        }
    }
}
