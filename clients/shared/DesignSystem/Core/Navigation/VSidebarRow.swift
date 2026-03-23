import SwiftUI

/// Sidebar navigation row used by both the main app sidebar and the component gallery.
///
/// Handles expanded (icon + label) and collapsed (icon-only) modes with consistent
/// spacing, backgrounds, and hover behavior. All metrics use shared design-system tokens.
///
/// Usage:
/// ```swift
/// VSidebarRow(icon: VIcon.brain.rawValue, label: "Intelligence", isActive: true) {
///     showPanel(.intelligence)
/// }
///
/// // With trailing content:
/// VSidebarRow(label: "Identity", isActive: true, action: { }) {
///     Text("5").font(VFont.caption).foregroundColor(VColor.contentTertiary)
/// }
/// ```
public struct VSidebarRow<Trailing: View>: View {
    public let icon: String?
    public let label: String
    public var isActive: Bool
    public var isExpanded: Bool
    public let action: () -> Void
    public let trailing: Trailing

    @State private var isHovered = false

    /// Icon slot size — all leading icons occupy a uniform 20x20 frame.
    private static var iconSlotSize: CGFloat { 20 }

    /// Minimum row height to ensure touch/click targets remain accessible.
    private static var rowMinHeight: CGFloat { 32 }

    public init(
        icon: String? = nil,
        label: String,
        isActive: Bool = false,
        isExpanded: Bool = true,
        action: @escaping () -> Void,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.icon = icon
        self.label = label
        self.isActive = isActive
        self.isExpanded = isExpanded
        self.action = action
        self.trailing = trailing()
    }

    private var iconColor: Color {
        isActive ? VColor.primaryActive : VColor.primaryBase
    }

    private var textColor: Color {
        isActive ? VColor.contentEmphasized : VColor.contentSecondary
    }

    public var body: some View {
        HStack(spacing: isExpanded ? VSpacing.xs : 0) {
            if let icon {
                VIconView(.resolve(icon), size: 13)
                    .foregroundColor(iconColor)
                    .frame(width: Self.iconSlotSize, height: Self.iconSlotSize)
            }
            Text(label)
                .font(VFont.body)
                .foregroundColor(textColor)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(width: isExpanded ? nil : 0, alignment: .leading)
                .clipped()
                .opacity(isExpanded ? 1 : 0)
                .allowsHitTesting(false)
            if isExpanded {
                Spacer()
                trailing
            }
        }
        .padding(.leading, isExpanded ? VSpacing.xs : 0)
        .padding(.trailing, isExpanded ? VSpacing.sm : 0)
        .padding(.vertical, VSpacing.xs)
        .frame(minHeight: Self.rowMinHeight)
        .frame(maxWidth: .infinity, alignment: isExpanded ? .leading : .center)
        .background(
            isActive ? VColor.surfaceActive :
            isHovered ? VColor.surfaceBase :
            Color.clear
        )
        .animation(VAnimation.fast, value: isHovered)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .contentShape(Rectangle())
        .onTapGesture { action() }
        .onHover { isHovered = $0 }
        .padding(.horizontal, 0)
        .help(isExpanded ? "" : label)
        .pointerCursor()
    }
}

// MARK: - Convenience initializers

public extension VSidebarRow where Trailing == EmptyView {
    /// Simple row with no trailing content.
    init(
        icon: String? = nil,
        label: String,
        isActive: Bool = false,
        isExpanded: Bool = true,
        action: @escaping () -> Void
    ) {
        self.init(icon: icon, label: label, isActive: isActive, isExpanded: isExpanded, action: action) {
            EmptyView()
        }
    }
}

public extension VSidebarRow where Trailing == VSidebarRowTrailingIcon {
    /// Row with a trailing icon and optional rotation (used by the main sidebar for disclosure arrows).
    init(
        icon: String? = nil,
        label: String,
        isActive: Bool = false,
        trailingIcon: String,
        trailingIconRotation: Angle = .zero,
        isExpanded: Bool = true,
        action: @escaping () -> Void
    ) {
        let active = isActive
        self.init(icon: icon, label: label, isActive: isActive, isExpanded: isExpanded, action: action) {
            VSidebarRowTrailingIcon(
                icon: trailingIcon,
                rotation: trailingIconRotation,
                isActive: active
            )
        }
    }
}

/// Trailing icon view extracted so the convenience init can reference a concrete type.
public struct VSidebarRowTrailingIcon: View {
    let icon: String
    var rotation: Angle = .zero
    var isActive: Bool = false

    private var iconColor: Color {
        isActive ? VColor.primaryActive : VColor.primaryBase
    }

    public var body: some View {
        VIconView(.resolve(icon), size: 10)
            .foregroundStyle(iconColor)
            .rotationEffect(rotation)
            .animation(VAnimation.fast, value: rotation)
    }
}
