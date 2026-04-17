import SwiftUI
import VellumAssistantShared

/// An inline pill/chip view for recap flowing text.
///
/// Displays text with an optional trailing priority icon. Background opacity
/// increases on hover to provide interactive feedback.
struct RecapPillView: View {

    // MARK: - Priority

    enum Priority {
        case high
        case medium
    }

    // MARK: - Properties

    let text: String
    var priority: Priority?
    var isHighlighted: Bool = false
    var onTap: (() -> Void)?

    @State private var isHovered = false

    // MARK: - Body

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            Text(text)
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentEmphasized)

            if let priority {
                VIconView(.circleAlert, size: 18)
                    .foregroundStyle(iconColor(for: priority))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 5)
        .background(
            VColor.auxWhite.opacity(backgroundOpacity)
        )
        .clipShape(Capsule())
        .pointerCursor(onHover: { hovering in
            isHovered = hovering
        })
        .onTapGesture {
            onTap?()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
        .accessibilityAddTraits(onTap != nil ? .isButton : [])
        .accessibilityAction {
            onTap?()
        }
    }

    // MARK: - Helpers

    private var backgroundOpacity: Double {
        (isHighlighted || isHovered) ? 0.5 : 0.1
    }

    private func iconColor(for priority: Priority) -> Color {
        switch priority {
        case .high:
            return VColor.systemNegativeStrong
        case .medium:
            return VColor.systemMidStrong
        }
    }
}
