import SwiftUI

/// A small colored pill that displays a risk level label.
///
/// Color-coded by risk level:
/// - `"low"` — green (`VColor.systemPositiveStrong`)
/// - `"medium"` — amber (`VColor.systemMidStrong`)
/// - `"high"` — red (`VColor.systemNegativeStrong`)
/// - Any other value — gray (`VColor.contentSecondary`)
///
/// When `onTap` is provided the badge renders as a tappable button with a
/// tooltip; otherwise it is a plain, non-interactive label.
struct RiskBadgeView: View {
    let riskLevel: String
    var onTap: (() -> Void)? = nil

    var body: some View {
        if let onTap {
            Button(action: onTap) {
                badgeContent
            }
            .buttonStyle(.plain)
            .help("Risk level: \(displayLabel). Click to create a rule.")
        } else {
            badgeContent
        }
    }

    private var badgeContent: some View {
        Text(displayLabel)
            .font(VFont.labelDefault)
            .foregroundStyle(textColor)
            .padding(EdgeInsets(top: 2, leading: 6, bottom: 2, trailing: 6))
            .background(backgroundColor)
            .clipShape(Capsule())
    }

    // MARK: - Display

    private var displayLabel: String {
        guard !riskLevel.isEmpty else { return "Unknown" }
        return riskLevel.prefix(1).uppercased() + riskLevel.dropFirst()
    }

    // MARK: - Color Mapping

    private var backgroundColor: Color {
        switch riskLevel.lowercased() {
        case "low":
            VColor.systemPositiveStrong
        case "medium":
            VColor.systemMidStrong
        case "high":
            VColor.systemNegativeStrong
        default:
            VColor.contentSecondary
        }
    }

    private var textColor: Color {
        switch riskLevel.lowercased() {
        case "medium":
            // Amber background is light — use dark text for contrast.
            VColor.auxBlack
        default:
            VColor.auxWhite
        }
    }
}
