import SwiftUI
import VellumAssistantShared

/// Right-hand detail panel surfaced when a scheduled feed item is selected
/// on the redesigned Home page.
///
/// Matches Figma node `3684:37504` (right-hand panel): a dark surface-lift
/// card with a 16pt corner, a header (amber calendar chip + title +
/// outlined close button), a body (description + details card listing
/// key/value rows), and a footer that pins optional secondary + primary
/// action buttons above a hairline divider.
///
/// The outer shell uses `VColor.surfaceLift` + `VColor.borderHover` to read
/// as the same "work surface" as `HomeDetailPanel`. Unlike that panel,
/// scheduled items have no scrolling content and no "Go to Thread"
/// action — the entire body is a fixed brief summary of the schedule.
struct HomeScheduledDetailPanel: View {
    /// One labeled row inside the details card. `key` is rendered on the
    /// leading edge in `contentTertiary`, `value` on the trailing edge in
    /// `contentDefault`.
    struct DetailRow: Identifiable, Hashable {
        var id: String { key }
        let key: String
        let value: String
    }

    let title: String
    let description: String
    let rows: [DetailRow]
    let primaryActionLabel: String
    let secondaryActionLabel: String?
    let onClose: () -> Void
    let onPrimaryAction: () -> Void
    let onSecondaryAction: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            Rectangle()
                .fill(VColor.borderHover)
                .frame(height: 1)
                .accessibilityHidden(true)

            bodySection

            Spacer(minLength: VSpacing.lg)

            footer
        }
        .frame(minWidth: 480, idealWidth: 600, maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                .fill(VColor.surfaceLift)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                .strokeBorder(VColor.borderHover, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(title))
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .center) {
            HStack(spacing: VSpacing.sm) {
                ZStack {
                    Circle().fill(VColor.feedThreadWeak)
                    VIconView(.calendar, size: 12)
                        .foregroundStyle(VColor.feedThreadStrong)
                }
                .frame(width: 26, height: 26)
                .accessibilityHidden(true)

                Text(title)
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentEmphasized)
                    .accessibilityAddTraits(.isHeader)
            }

            Spacer(minLength: 0)

            Button(action: onClose) {
                ZStack {
                    RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                        .strokeBorder(VColor.borderElement, lineWidth: 1)
                    VIconView(.x, size: 9)
                        .foregroundStyle(VColor.contentEmphasized)
                }
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel(Text("Close"))
        }
        .padding(VSpacing.lg)
    }

    // MARK: - Body

    private var bodySection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text(description)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .fixedSize(horizontal: false, vertical: true)

            detailsCard
        }
        .padding(EdgeInsets(
            top: VSpacing.lg,
            leading: VSpacing.lg,
            bottom: 0,
            trailing: VSpacing.lg
        ))
    }

    private var detailsCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Details")
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentEmphasized)

            ForEach(rows) { row in
                HStack {
                    Text(row.key)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentTertiary)
                    Spacer()
                    Text(row.value)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                }
            }
        }
        .padding(EdgeInsets(
            top: VSpacing.md,
            leading: VSpacing.md,
            bottom: VSpacing.lg,
            trailing: VSpacing.md
        ))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous)
                .fill(VColor.surfaceOverlay)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous)
                .strokeBorder(VColor.borderHover, lineWidth: 1)
        )
    }

    // MARK: - Footer

    private var footer: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(VColor.borderHover)
                .frame(height: 1)
                .accessibilityHidden(true)

            HStack(alignment: .center, spacing: VSpacing.sm) {
                Spacer()

                if let secondaryActionLabel {
                    Button(action: { onSecondaryAction?() }) {
                        Text(secondaryActionLabel)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentEmphasized)
                            .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                            .frame(height: 32)
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                                    .strokeBorder(VColor.borderElement, lineWidth: 1)
                            )
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                    .accessibilityLabel(Text(secondaryActionLabel))
                }

                Button(action: onPrimaryAction) {
                    Text(primaryActionLabel)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentInset)
                        .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
                        .frame(height: 32)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.md, style: .continuous)
                                .fill(VColor.contentEmphasized)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .accessibilityLabel(Text(primaryActionLabel))
            }
            .padding(VSpacing.lg)
        }
    }
}
