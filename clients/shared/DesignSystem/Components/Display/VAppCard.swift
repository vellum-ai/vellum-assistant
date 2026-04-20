import SwiftUI

/// App-tile card that matches the Figma `App Card` component. Shows a preview
/// thumbnail at the top, a title + short description, and a button row with a
/// primary "Open" action, an outlined "Pin" toggle, and an icon-only
/// secondary action slot.
///
/// The preview is supplied as a view builder so callers can use cached remote
/// images, icon placeholders, or any other content.
public struct VAppCard<Preview: View>: View {
    public let title: String
    public let description: String?
    public var icon: VIcon?
    public var isPinned: Bool
    public var isOpenDisabled: Bool
    public var pinLabel: String
    public var unpinLabel: String
    public var secondaryIcon: VIcon
    public var onOpen: (() -> Void)?
    public var onPin: (() -> Void)?
    public var onSecondary: (() -> Void)?
    @ViewBuilder public let preview: () -> Preview

    public init(
        title: String,
        description: String? = nil,
        icon: VIcon? = nil,
        isPinned: Bool = false,
        isOpenDisabled: Bool = false,
        pinLabel: String = "Pin",
        unpinLabel: String = "Unpin",
        secondaryIcon: VIcon = .arrowUp,
        onOpen: (() -> Void)? = nil,
        onPin: (() -> Void)? = nil,
        onSecondary: (() -> Void)? = nil,
        @ViewBuilder preview: @escaping () -> Preview
    ) {
        self.title = title
        self.description = description
        self.icon = icon
        self.isPinned = isPinned
        self.isOpenDisabled = isOpenDisabled
        self.pinLabel = pinLabel
        self.unpinLabel = unpinLabel
        self.secondaryIcon = secondaryIcon
        self.onOpen = onOpen
        self.onPin = onPin
        self.onSecondary = onSecondary
        self.preview = preview
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            preview()
                .frame(maxWidth: .infinity)
                .frame(height: 187)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                HStack(spacing: VSpacing.sm) {
                    if let icon {
                        VIconView(icon, size: 16)
                            .foregroundStyle(VColor.contentEmphasized)
                    }
                    Text(title)
                        .font(VFont.bodyLargeEmphasised)
                        .foregroundStyle(VColor.contentEmphasized)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let description, !description.isEmpty {
                    Text(description)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            HStack(spacing: VSpacing.sm) {
                if let onOpen {
                    VButton(
                        label: "Open App",
                        leftIcon: VIcon.externalLink.rawValue,
                        style: .primary,
                        isDisabled: isOpenDisabled,
                        action: onOpen
                    )
                }
                if let onPin {
                    VButton(
                        label: isPinned ? unpinLabel : pinLabel,
                        leftIcon: isPinned ? VIcon.pinOff.rawValue : VIcon.pin.rawValue,
                        style: .outlined,
                        action: onPin
                    )
                }
                Spacer(minLength: 0)
                if let onSecondary {
                    VButton(
                        label: "",
                        iconOnly: secondaryIcon.rawValue,
                        style: .outlined,
                        action: onSecondary
                    )
                }
            }
        }
        .padding(VSpacing.lg)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceOverlay)
        )
    }
}
