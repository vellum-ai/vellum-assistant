import SwiftUI
import VellumAssistantShared

/// Inline banner announcing that this Swift build is deprecated in favor of
/// the new Vellum desktop app, rendered above the composer in ChatView.
///
/// Always shown and intentionally not dismissible — switching to the new app
/// requires downloading a fresh DMG, so the call to action must remain visible.
/// Single-row layout: icon + text on the left, "Download" button on the right.
struct DeprecatedAppBanner: View {
    let onDownload: () -> Void

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.sparkles, size: 14)
                .foregroundStyle(VColor.primaryBase)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 0) {
                Text("A new Vellum app is here")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)

                Text("This version is no longer maintained — download the new app to keep getting updates")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(1)
            }
            .layoutPriority(1)

            Spacer(minLength: 0)

            VButton(
                label: "Download",
                leftIcon: VIcon.arrowDownToLine.rawValue,
                style: .primary,
                size: .compact
            ) {
                onDownload()
            }
            .accessibilityLabel("Download the new Vellum app")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(VColor.surfaceActive)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: VRadius.lg,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: VRadius.lg
            )
        )
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .accessibilityElement(children: .contain)
    }
}
