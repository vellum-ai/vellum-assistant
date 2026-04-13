import SwiftUI
import VellumAssistantShared

/// A pill-shaped chip that renders a single `Fact` from the relationship state.
///
/// Visual mapping (driven entirely by the `Fact` enums in
/// `clients/shared/Models/RelationshipState.swift`):
///
/// - **Background tint** — by category:
///   - `.voice` → purple
///   - `.world` → blue
///   - `.priorities` → amber
/// - **Confidence dot** (small leading `Circle`):
///   - `.strong` → green
///   - `.uncertain` → gold
/// - **Border**:
///   - `.onboarding` → dashed (`StrokeStyle(lineWidth: 1, dash: [3, 3])`)
///   - `.inferred` → solid
/// - **Label** — fact text, multi-line, truncates with an adaptive max width.
struct FactChipView: View {
    let fact: Fact

    /// Cap chip width so a single long fact wraps to multiple lines instead of
    /// stretching across the entire facts row. `FlowLayout` handles the wrap
    /// between chips; this controls the wrap inside a single chip.
    var maxWidth: CGFloat = 220

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle()
                .fill(confidenceDotColor)
                .frame(width: 6, height: 6)
                // Nudge the dot down so it visually centers on the cap-height
                // of the first text line.
                .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 3 }

            Text(fact.text)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(3)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
        .frame(maxWidth: maxWidth, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(backgroundTint)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(borderColor, style: borderStrokeStyle)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(accessibilityDescription))
    }

    // MARK: - Visual mapping

    private var backgroundTint: Color {
        switch fact.category {
        case .voice:      return VColor.funPurple.opacity(0.15)
        case .world:      return VColor.funBlue.opacity(0.15)
        case .priorities: return VColor.systemMidStrong.opacity(0.18)
        }
    }

    private var borderColor: Color {
        switch fact.category {
        case .voice:      return VColor.funPurple.opacity(0.55)
        case .world:      return VColor.funBlue.opacity(0.55)
        case .priorities: return VColor.systemMidStrong.opacity(0.65)
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
        return "\(categoryLabel) fact, \(confidenceLabel) confidence: \(fact.text)"
    }
}
