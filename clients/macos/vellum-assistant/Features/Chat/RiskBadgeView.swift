import SwiftUI
import VellumAssistantShared

/// A small colored pill that displays a risk level label.
///
/// Uses the design system's "weak" palette — muted pastel backgrounds with
/// the corresponding strong semantic color for text — so the badge conveys
/// risk without visually competing with chat content.
///
/// When `onTap` is provided the badge renders as a tappable button with a
/// tooltip; otherwise it is a plain, non-interactive label.
struct RiskBadgeView: View {
    let riskLevel: String
    var hasExistingRule: Bool = false
    var provenanceText: String? = nil
    /// Optional override for the tooltip text. When nil, the default
    /// "Risk level: …" help text is used.
    var helpText: String? = nil
    var onTap: (() -> Void)? = nil

    var body: some View {
        if let onTap {
            let tooltip = helpText ?? "Risk level: \(displayLabel). \(hasExistingRule ? "Click to edit the matching rule." : "Click to create a rule.")"
            Button(action: onTap) {
                badgeContent
            }
            .buttonStyle(.plain)
            .help(tooltip)
        } else {
            badgeContent
        }
    }

    private var isWorkspaceChip: Bool {
        riskLevel.lowercased() == "workspace"
    }

    private var badgeContent: some View {
        Text(displayLabel)
            .font(VFont.labelDefault)
            .foregroundStyle(textColor)
            .padding(EdgeInsets(top: 2, leading: 6, bottom: 2, trailing: 6))
            .background(backgroundColor)
            .clipShape(Capsule())
            .overlay {
                if isWorkspaceChip {
                    Capsule().stroke(VColor.borderElement, lineWidth: 1)
                }
            }
    }

    // MARK: - Display

    private var displayLabel: String {
        if isWorkspaceChip {
            return "Workspace"
        }
        let base = riskLevel.isEmpty ? "Unknown" : riskLevel.prefix(1).uppercased() + riskLevel.dropFirst()
        if let provenance = provenanceText {
            return "\(base) \(provenance)"
        }
        return base
    }

    // MARK: - Color Mapping

    private var backgroundColor: Color {
        switch riskLevel.lowercased() {
        case "low":
            VColor.systemPositiveWeak
        case "medium":
            VColor.systemMidWeak
        case "high":
            VColor.systemNegativeWeak
        case "workspace":
            VColor.surfaceLift
        default:
            VColor.surfaceBase
        }
    }

    private var textColor: Color {
        switch riskLevel.lowercased() {
        case "low":
            VColor.systemPositiveStrong
        case "medium":
            VColor.systemMidStrong
        case "high":
            VColor.systemNegativeStrong
        case "workspace":
            VColor.contentSecondary
        default:
            VColor.contentSecondary
        }
    }
}
