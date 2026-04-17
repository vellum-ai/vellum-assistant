import SwiftUI
import VellumAssistantShared

/// A grouped card showing a list of low-priority update notifications.
///
/// Displays a count header ("N other updates") with a "Clear all" bordered
/// pill button and a scrollable list of tappable update items, each showing
/// an icon, title, and thread name in a pill row.
struct HomeUpdatesListCard: View {

    // MARK: - Update Item

    struct UpdateItem {
        let icon: VIcon
        let title: String
        let threadName: String
    }

    // MARK: - Properties

    let updates: [UpdateItem]
    let onClearAll: () -> Void
    let onSelectUpdate: (Int) -> Void

    // MARK: - Body

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            headerRow
            updatesList
        }
        .recapCardGlass()
        .recapCardMaxWidth(fill: true)
    }

    // MARK: - Header Row

    private var headerRow: some View {
        HStack(spacing: VSpacing.sm) {
            HomeRecapCardHeader(
                icon: .list,
                title: "\(updates.count) other updates"
            )

            clearAllButton
        }
    }

    // MARK: - Clear All Button

    private var clearAllButton: some View {
        VButton(
            label: "Clear all",
            style: .outlined,
            size: .pillRegular,
            accessibilityID: "clear-all-updates",
            action: onClearAll
        )
    }

    // MARK: - Updates List

    private var updatesList: some View {
        VStack(spacing: 4) {
            ForEach(Array(updates.enumerated()), id: \.offset) { index, item in
                updateRow(item: item)
                    .onTapGesture {
                        onSelectUpdate(index)
                    }
                    .pointerCursor()
            }
        }
    }

    // MARK: - Update Row

    private func updateRow(item: UpdateItem) -> some View {
        HStack(spacing: VSpacing.sm) {
            updateIconCircle(icon: item.icon)

            VStack(alignment: .leading, spacing: 0) {
                Text(item.title)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)

                Text(item.threadName)
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .padding(EdgeInsets(top: 2, leading: 2, bottom: 2, trailing: VSpacing.lg))
        .background(
            Capsule()
                .fill(VColor.surfaceOverlay)
        )
    }

    // MARK: - Update Icon Circle

    /// 26pt circular container matching HomeLinkFileRow style.
    private func updateIconCircle(icon: VIcon) -> some View {
        ZStack {
            Circle()
                .fill(VColor.surfaceLift)
                .frame(width: 26, height: 26)

            VIconView(icon, size: 12)
                .foregroundStyle(VColor.contentSecondary)
        }
    }
}
