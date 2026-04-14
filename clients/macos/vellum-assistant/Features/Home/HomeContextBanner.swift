import SwiftUI
import VellumAssistantShared

/// Single-line context strip that sits flush above the Home activity feed.
///
/// Renders three server-composed segments — greeting, time-away label, and
/// optional "N new" count — separated by middot dividers. The greeting and
/// time-away strings are prepared by the assistant, so this view is pure
/// layout: no date math, no localization, no store coupling.
///
/// When `banner.newCount == 0` the "N new" segment *and* its leading
/// middot separator are hidden entirely so the banner never reads
/// "… · 0 new". When it's positive, the segment is appended with its
/// own middot so the dividers look consistent.
///
/// The view deliberately has no background fill — it's meant to sit
/// flush above the feed section as a secondary-text annotation, not as
/// its own card.
struct HomeContextBannerView: View {
    let banner: ContextBanner

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            Text(banner.greeting)
            separator
            Text(banner.timeAwayLabel)
            if banner.newCount > 0 {
                separator
                Text("\(banner.newCount) new")
            }
        }
        .font(VFont.bodySmallDefault)
        .foregroundStyle(VColor.contentSecondary)
        .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.md, bottom: VSpacing.sm, trailing: VSpacing.md))
        .accessibilityElement(children: .combine)
    }

    private var separator: some View {
        Text("·")
            .accessibilityHidden(true)
    }
}
