import SwiftUI

/// A disclosure section with a full-row clickable header.
///
/// Replaces native `DisclosureGroup` to provide a larger tap target — the entire
/// header row (title + optional subtitle + chevron) toggles expansion, not just
/// the tiny default chevron.
///
/// Usage:
/// ```swift
/// VDisclosureSection(title: "Advanced", subtitle: "Bearer token, developer options", isExpanded: $expanded) {
///     Text("Content here")
/// }
/// ```
public struct VDisclosureSection<Content: View>: View {
    public let title: String
    public var subtitle: String? = nil
    @Binding public var isExpanded: Bool
    @ViewBuilder public let content: () -> Content

    public init(
        title: String,
        subtitle: String? = nil,
        isExpanded: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
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
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text(title)
                            .font(VFont.bodyBold)
                            .foregroundColor(VColor.textPrimary)
                        if let subtitle {
                            Text(subtitle)
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }

                    Spacer()

                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(VColor.textMuted)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .animation(VAnimation.fast, value: isExpanded)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(title), \(isExpanded ? "expanded" : "collapsed")")
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
                VColor.background.ignoresSafeArea()
                VStack(spacing: VSpacing.lg) {
                    VDisclosureSection(
                        title: "Gateway",
                        isExpanded: $basicExpanded
                    ) {
                        Text("Gateway content goes here")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)

                    VDisclosureSection(
                        title: "Advanced",
                        subtitle: "Bearer token, developer options",
                        isExpanded: $subtitleExpanded
                    ) {
                        Text("Advanced content goes here")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)

                    VDisclosureSection(
                        title: "Diagnostics",
                        isExpanded: $collapsedExpanded
                    ) {
                        Text("Diagnostics content goes here")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                    }
                    .padding(VSpacing.lg)
                    .vCard(background: VColor.surfaceSubtle)
                }
                .padding()
            }
            .frame(width: 400, height: 400)
        }
    }

    return DisclosurePreview()
}
