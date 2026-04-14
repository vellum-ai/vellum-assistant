import SwiftUI
import VellumAssistantShared

/// A pill-shaped chip rendering a single `Fact` from the relationship state.
///
/// The chip is intentionally small and refined — a label, not a card. Visual
/// mapping is driven entirely by the `Fact` enums, with no hardcoded copy:
///
/// - **Background tint** comes from the category (voice purple, world blue,
///   priorities amber). The tint is deliberately faint so a row of chips
///   reads as a soft palette rather than a stripe of saturated boxes.
/// - **Source** drives the border style — a dashed border for facts the user
///   told us during onboarding, a solid border for facts we inferred from
///   conversation. This is the "transparency with receipts" principle:
///   readers can always tell what they told us vs. what we figured out.
/// - **Confidence** drives a tiny leading dot — green for strong, gold for
///   uncertain. The dot intentionally sits above the text baseline so it
///   reads as a "marker", not a bullet.
struct FactChipView: View {
    let fact: Fact

    /// Cap chip width so a long fact wraps to two lines instead of stretching
    /// across the entire row. The shared `FlowLayout` measures children at
    /// their actual rendered size, so this cap is the only thing keeping a
    /// long fact from making the parent row a single chip wide.
    var maxWidth: CGFloat = 200

    var body: some View {
        HStack(alignment: .top, spacing: VSpacing.xs) {
            Circle()
                .fill(confidenceDotColor)
                .frame(width: 5, height: 5)
                .padding(.top, 5)

            Text(fact.text)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(2)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(EdgeInsets(top: 5, leading: 10, bottom: 5, trailing: 10))
        .frame(maxWidth: maxWidth, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous)
                .fill(backgroundTint)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous)
                .strokeBorder(borderColor, style: borderStrokeStyle)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(accessibilityDescription))
    }

    // MARK: - Visual mapping

    private var backgroundTint: Color {
        switch fact.category {
        case .voice:      return VColor.funPurple.opacity(0.10)
        case .world:      return VColor.funBlue.opacity(0.10)
        case .priorities: return VColor.systemMidStrong.opacity(0.13)
        }
    }

    private var borderColor: Color {
        switch fact.category {
        case .voice:      return VColor.funPurple.opacity(0.40)
        case .world:      return VColor.funBlue.opacity(0.40)
        case .priorities: return VColor.systemMidStrong.opacity(0.50)
        }
    }

    private var borderStrokeStyle: StrokeStyle {
        switch fact.source {
        case .onboarding:
            return StrokeStyle(lineWidth: 1, dash: [3, 3])
        case .inferred:
            return StrokeStyle(lineWidth: 1)
        }
    }

    private var confidenceDotColor: Color {
        switch fact.confidence {
        case .strong:    return VColor.systemPositiveStrong
        case .uncertain: return VColor.systemMidStrong
        }
    }

    private var accessibilityDescription: String {
        let categoryLabel: String
        switch fact.category {
        case .voice:      categoryLabel = "Voice"
        case .world:      categoryLabel = "World"
        case .priorities: categoryLabel = "Priorities"
        }
        let confidenceLabel: String
        switch fact.confidence {
        case .strong:    confidenceLabel = "strong"
        case .uncertain: confidenceLabel = "uncertain"
        }
        let sourceLabel: String
        switch fact.source {
        case .onboarding: sourceLabel = "you told me"
        case .inferred:   sourceLabel = "I figured this out"
        }
        return "\(categoryLabel) fact, \(confidenceLabel) confidence, \(sourceLabel): \(fact.text)"
    }
}
