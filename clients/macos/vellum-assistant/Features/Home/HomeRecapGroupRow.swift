import SwiftUI
import VellumAssistantShared

/// A grouped recap card used in the Home feed when multiple related
/// feed items should collapse behind a single "parent" summary row.
///
/// Layout (Figma `3679:21591`):
///   • Outer card: `VColor.surfaceOverlay` fill, `VRadius.md` corner,
///     padded `pt=8 / lead=12 / bot=12 / trail=12`.
///   • Header row: 26pt tinted circle (12pt glyph) + secondary title —
///     mirrors ``HomeRecapRow`` so the two row types read as one family.
///   • Children: an expandable `VColor.surfaceLift` list below the
///     header, 4pt row gap, each child padded `px=12 / py=8`.
///
/// Expand/collapse is owned by the caller via `isExpanded: Binding<Bool>`
/// and `onParentTap`, so the caller can run side effects (analytics,
/// selection changes) alongside the toggle. To animate the reveal the
/// caller should wrap the state flip in ``VAnimation/fast`` — e.g.
/// `withAnimation(VAnimation.fast) { isExpanded.toggle() }`. The view
/// itself only supplies the `.transition(...)` on the conditional block.
struct HomeRecapGroupRow: View {

    /// A nested feed item rendered inside the expanded children list.
    struct Child: Identifiable, Hashable {
        let id: String
        let icon: VIcon
        let iconForeground: Color
        let iconBackground: Color
        let title: String
    }

    let parentIcon: VIcon
    let parentIconForeground: Color
    let parentIconBackground: Color
    let parentTitle: String
    let children: [Child]
    let isExpanded: Binding<Bool>
    /// Caller toggles `isExpanded` — kept as a closure so analytics or
    /// other side effects can run alongside the state flip.
    let onParentTap: () -> Void
    let onChildTap: (Child) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            header

            if isExpanded.wrappedValue {
                childrenList
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.md, bottom: VSpacing.md, trailing: VSpacing.md))
        .background(
            RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                .fill(VColor.surfaceOverlay)
        )
    }

    // MARK: - Header (parent row)

    private var header: some View {
        Button(action: onParentTap) {
            HStack(spacing: VSpacing.sm) {
                ZStack {
                    Circle().fill(parentIconBackground)
                    // 12pt glyph inside a 26pt circle — matches HomeRecapRow.
                    VIconView(parentIcon, size: 12)
                        .foregroundStyle(parentIconForeground)
                }
                .frame(width: 26, height: 26)

                Text(parentTitle)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(parentTitle))
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(Text(isExpanded.wrappedValue ? "Expanded" : "Collapsed"))
        .accessibilityHint(Text("Double-tap to \(isExpanded.wrappedValue ? "collapse" : "expand") \(children.count) updates"))
    }

    // MARK: - Children

    private var childrenList: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            ForEach(children) { child in
                childRow(child)
            }
        }
    }

    private func childRow(_ child: Child) -> some View {
        Button(action: { onChildTap(child) }) {
            HStack(spacing: VSpacing.sm) {
                ZStack {
                    Circle().fill(child.iconBackground)
                    VIconView(child.icon, size: 12)
                        .foregroundStyle(child.iconForeground)
                }
                .frame(width: 26, height: 26)

                Text(child.title)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: VSpacing.sm)
            }
            .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.md, bottom: VSpacing.sm, trailing: VSpacing.md))
            .background(
                RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                    .fill(VColor.surfaceLift)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(child.title))
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: - Previews

private let previewChildren: [HomeRecapGroupRow.Child] = [
    .init(
        id: "1",
        icon: .bell,
        iconForeground: VColor.feedDigestStrong,
        iconBackground: VColor.feedDigestWeak,
        title: "This is the First notification in the group"
    ),
    .init(
        id: "2",
        icon: .bell,
        iconForeground: VColor.feedDigestStrong,
        iconBackground: VColor.feedDigestWeak,
        title: "This is the Second notification in the group"
    ),
    .init(
        id: "3",
        icon: .bell,
        iconForeground: VColor.feedDigestStrong,
        iconBackground: VColor.feedDigestWeak,
        title: "This is the Third notification in the group"
    ),
    .init(
        id: "4",
        icon: .bell,
        iconForeground: VColor.feedDigestStrong,
        iconBackground: VColor.feedDigestWeak,
        title: "This is the Fourth notification in the group"
    ),
]

#Preview("Expanded") {
    VStack {
        HomeRecapGroupRow(
            parentIcon: .bell,
            parentIconForeground: VColor.feedDigestStrong,
            parentIconBackground: VColor.feedDigestWeak,
            parentTitle: "There's also 4 low priority updates if you want to have a look.",
            children: previewChildren,
            isExpanded: .constant(true),
            onParentTap: {},
            onChildTap: { _ in }
        )
    }
    .frame(width: 720)
    .padding()
    .background(VColor.surfaceBase)
}

#Preview("Collapsed") {
    VStack {
        HomeRecapGroupRow(
            parentIcon: .bell,
            parentIconForeground: VColor.feedDigestStrong,
            parentIconBackground: VColor.feedDigestWeak,
            parentTitle: "There's also 4 low priority updates if you want to have a look.",
            children: previewChildren,
            isExpanded: .constant(false),
            onParentTap: {},
            onChildTap: { _ in }
        )
    }
    .frame(width: 720)
    .padding()
    .background(VColor.surfaceBase)
}
