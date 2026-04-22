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
///
/// Dismiss affordance: when `onParentDismiss` / `onChildDismiss` are
/// supplied, a hover-only "Dismiss" button appears on the parent header
/// and on each child row — matching the single-row `HomeRecapRow`
/// treatment so grouped and non-grouped rows share the same dismiss
/// behavior (Codex/Devin review feedback on PR #27475).
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
    /// Optional dismiss for the parent summary row. When nil, no dismiss
    /// affordance renders on the parent header.
    var onParentDismiss: (() -> Void)? = nil
    /// Optional dismiss for an individual child row. When nil, no dismiss
    /// affordance renders on children.
    var onChildDismiss: ((Child) -> Void)? = nil

    @State private var isParentHovering: Bool = false

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

                Spacer(minLength: VSpacing.sm)

                if isParentHovering, let onParentDismiss {
                    Self.dismissButton(action: onParentDismiss)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .onHover { isParentHovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(parentTitle))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: Text("Dismiss"), onParentDismiss ?? {})
    }

    // MARK: - Children

    private var childrenList: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            ForEach(children) { child in
                ChildRow(
                    child: child,
                    onTap: { onChildTap(child) },
                    onDismiss: onChildDismiss.map { callback in { callback(child) } }
                )
            }
        }
    }

    // MARK: - Shared dismiss button

    /// Single-source renderer for the hover-only "Dismiss" affordance.
    /// Matches `HomeRecapRow`'s styling so grouped/non-grouped rows share
    /// the same dismiss treatment. The outer `Button` isolates the tap
    /// from the enclosing row button — SwiftUI resolves the innermost
    /// tappable first.
    fileprivate static func dismissButton(action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: VSpacing.xs) {
                VIconView(.x, size: 7)
                    .foregroundStyle(VColor.contentDisabled)
                Text("Dismiss")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentDisabled)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .accessibilityLabel(Text("Dismiss"))
    }
}

// MARK: - Child row subview

/// Private subview that owns its own hover state so each child row can
/// independently reveal/hide the dismiss affordance without re-rendering
/// the whole group.
private struct ChildRow: View {
    let child: HomeRecapGroupRow.Child
    let onTap: () -> Void
    let onDismiss: (() -> Void)?

    @State private var isHovering: Bool = false

    var body: some View {
        Button(action: onTap) {
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

                if isHovering, let onDismiss {
                    HomeRecapGroupRow.dismissButton(action: onDismiss)
                }
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
        .onHover { isHovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(child.title))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: Text("Dismiss"), onDismiss ?? {})
    }
}
