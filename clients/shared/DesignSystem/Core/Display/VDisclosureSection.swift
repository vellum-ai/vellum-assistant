import SwiftUI

/// A disclosure section with a full-row clickable header.
///
/// Replaces native `DisclosureGroup` to provide a larger tap target — the entire
/// header row (title + optional subtitle + chevron) toggles expansion, not just
/// the tiny default chevron.
///
/// Usage:
/// ```swift
/// VDisclosureSection(title: "Advanced", icon: "gearshape", subtitle: "Bearer token, developer options", isExpanded: $expanded) {
///     Text("Content here")
/// }
/// ```
public struct VDisclosureSection<Content: View>: View {
    public let title: String
    public var icon: String? = nil
    public var subtitle: String? = nil
    @Binding public var isExpanded: Bool
    @ViewBuilder public let content: () -> Content

    public init(
        title: String,
        icon: String? = nil,
        subtitle: String? = nil,
        isExpanded: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.icon = icon
        self.subtitle = subtitle
        self._isExpanded = isExpanded
        self.content = content
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(VAnimation.fast) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: VSpacing.sm) {
                    if let icon {
                        VIconView(.resolve(icon), size: 14)
                            .foregroundColor(VColor.contentTertiary)
                            .frame(width: 20)
                    }

                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text(title)
                            .font(VFont.bodyBold)
                            .foregroundColor(VColor.contentDefault)
                        if let subtitle {
                            Text(subtitle)
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }

                    Spacer()

                    VIconView(.chevronRight, size: 10)
                        .foregroundColor(VColor.contentTertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .animation(VAnimation.fast, value: isExpanded)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel(subtitle.map { "\(title), \($0)" } ?? title)
            .accessibilityValue(isExpanded ? "expanded" : "collapsed")
            .accessibilityHint("Double-tap to \(isExpanded ? "collapse" : "expand")")

            if isExpanded {
                content()
                    .padding(.top, VSpacing.sm)
            }
        }
    }
}

#Preview("VDisclosureSection") {
    struct DisclosurePreview: View {
        @State private var basicExpanded = true
        @State private var subtitleExpanded = false
        @State private var collapsedExpanded = false

        var body: some View {
            ZStack {
                VColor.surfaceOverlay.ignoresSafeArea()
                VStack(spacing: VSpacing.lg) {
                    VDisclosureSection(
                        title: "Gateway",
                        icon: VIcon.network.rawValue,
                        isExpanded: $basicExpanded
                    ) {
                        Text("Gateway content goes here")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentSecondary)
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceOverlay)

                    VDisclosureSection(
                        title: "Advanced",
                        icon: VIcon.slidersHorizontal.rawValue,
                        subtitle: "Bearer token, developer options",
                        isExpanded: $subtitleExpanded
                    ) {
                        Text("Advanced content goes here")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentSecondary)
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceOverlay)

                    VDisclosureSection(
                        title: "Diagnostics",
                        icon: VIcon.stethoscope.rawValue,
                        isExpanded: $collapsedExpanded
                    ) {
                        Text("Diagnostics content goes here")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentSecondary)
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceOverlay)
                }
                .padding()
            }
            .frame(width: 400, height: 400)
        }
    }

    return DisclosurePreview()
}
