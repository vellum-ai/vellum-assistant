import AppIntents
import SwiftUI
import WidgetKit

/// The small Home Screen widget: the ways to start something, plus a count of
/// what is waiting.
///
/// Small only. Every action here is one tap target and none of them grow with
/// more room, so a medium instance would be the same buttons with half a card
/// of padding around them. `CatchUpWidget` is the medium answer.
///
/// Configurable rather than static, and configurable for exactly one reason:
/// the card is either the brand block or the system surface. See
/// ``QuickActionsAppearance``.
///
/// The widget declares no `widgetURL`, so a tap outside the buttons falls
/// through to WidgetKit's default of launching the app, which is the same
/// "land where you left off" behavior `OpenVellumIntent` gives the Control
/// Center control. Nothing here needs a destination the app does not already
/// have the user parked on.
struct QuickActionsWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: VellumWidgetKind.quickActions,
            intent: QuickActionsAppearanceIntent.self,
            provider: QuickActionsProvider()
        ) { entry in
            QuickActionsWidgetView(entry: entry)
                .containerBackground(entry.appearance.cardSurface, for: .widget)
        }
        .configurationDisplayName("Quick Actions")
        .description("Take a photo or start a voice conversation. The Light appearance adds a Chat button.")
        .supportedFamilies([.systemSmall])
    }
}

/// One rendering of the Quick Actions widget: the snapshot every Vellum widget
/// shares, plus the appearance this particular instance was configured with.
///
/// The appearance rides on the entry because that is the only channel an
/// `AppIntentConfiguration` gives the view: the content closure receives an
/// entry and nothing else, so the provider is where configuration and snapshot
/// meet.
struct QuickActionsEntry: TimelineEntry {
    let snapshotEntry: SnapshotEntry
    let appearance: QuickActionsAppearance

    var date: Date { snapshotEntry.date }

    /// The number for the unread chip, or nil when there is no chip to draw:
    /// nothing unread, nothing synced, or a snapshot old enough that the count
    /// is a claim about an inbox from half an hour ago.
    ///
    /// `CatchUpRow` keeps its unread dot past that same threshold, and the two
    /// are consistent rather than in tension. A dot says "this conversation
    /// has something in it you have not read", which stays true until someone
    /// opens the app and resyncs. A count says how many are waiting *now*, and
    /// messages arriving while the app is closed are exactly what the widget
    /// cannot see. So the fact survives staleness and the tally does not.
    var unreadCount: Int? {
        guard !snapshotEntry.isStale,
              let count = snapshotEntry.snapshot?.unreadCount,
              count > 0
        else {
            return nil
        }
        return count
    }
}

/// ``SnapshotProvider``'s timeline, restated in the shape a configurable
/// widget requires, with the chosen appearance folded into every entry.
///
/// `AppIntentConfiguration` takes an `AppIntentTimelineProvider` and the shared
/// provider is a plain `TimelineProvider`, so something has to restate one as
/// the other. This calls ``SnapshotProvider``'s synchronous producers instead
/// of re-reading the store: which snapshot to render and when it stops being
/// fresh are one decision for all the Vellum widgets, and a second copy of the
/// staleness rule is a second copy that drifts.
struct QuickActionsProvider: AppIntentTimelineProvider {
    private let snapshots = SnapshotProvider()

    func placeholder(in context: Context) -> QuickActionsEntry {
        QuickActionsEntry(snapshotEntry: snapshots.placeholder(in: context), appearance: .brand)
    }

    func snapshot(
        for configuration: QuickActionsAppearanceIntent,
        in context: Context
    ) async -> QuickActionsEntry {
        QuickActionsEntry(
            snapshotEntry: snapshots.entry(in: context),
            appearance: configuration.appearance
        )
    }

    func timeline(
        for configuration: QuickActionsAppearanceIntent,
        in context: Context
    ) async -> Timeline<QuickActionsEntry> {
        let timeline = snapshots.timeline(now: Date())
        return Timeline(
            entries: timeline.entries.map {
                QuickActionsEntry(snapshotEntry: $0, appearance: configuration.appearance)
            },
            policy: timeline.policy
        )
    }
}

/// Two cards, both leading with camera and voice.
///
/// There is no empty state and no signed-out state to draw: the buttons are
/// what the widget is, and they work with nothing synced at all. The unread
/// chip is the one part that reads the snapshot, so a missing snapshot costs
/// the widget a chip and nothing else.
struct QuickActionsWidgetView: View {
    /// The height everything on the card is drawn at: both circles, the Chat
    /// pill, and the avatar above them. A small widget has room for one unit of
    /// measure, and a handful of elements at a handful of sizes reads as an
    /// accident rather than as a layout.
    private static let controlDiameter: CGFloat = 44

    let entry: QuickActionsEntry

    var body: some View {
        switch entry.appearance {
        case .brand:
            brandCard
        case .light:
            lightCard
        }
    }

    /// The mark up top, the two most physical actions under it, and the chip
    /// tucked into the corner the mark leaves empty.
    ///
    /// Chat is not on this card. Three buttons on a green block crowds it, and
    /// a tap anywhere outside the two circles already opens the app, which is
    /// most of the way to a new chat. The light card, which spends its width on
    /// a pill instead of on a mark, is where Chat gets a button of its own.
    private var brandCard: some View {
        VStack(spacing: 0) {
            QuickActionsAvatar(size: Self.controlDiameter)
            Spacer(minLength: 10)
            cameraAndVoice
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .topTrailing) { unreadChip }
    }

    /// The quiet card: two circles over a full-width Chat pill.
    ///
    /// Chat gets the wide target because it is the action most people want most
    /// often, and the pill is the only shape on a small widget that can say so.
    private var lightCard: some View {
        VStack(spacing: 12) {
            cameraAndVoice
            PillActionButton(
                intent: OpenNewChatIntent(),
                icon: Image("VellumV"),
                title: "Chat",
                fill: WidgetTheme.newChatFill,
                tint: WidgetTheme.brand,
                height: Self.controlDiameter
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The pair both cards lead with, written once so the two appearances
    /// cannot drift into offering different camera and voice actions or
    /// different VoiceOver labels. Only the colors differ, and those come from
    /// the appearance.
    private var cameraAndVoice: some View {
        HStack(spacing: 12) {
            CircleActionButton(
                intent: OpenCameraIntent(),
                icon: Image(systemName: "camera.fill"),
                label: "Take a photo",
                fill: entry.appearance.controlFill,
                tint: entry.appearance.controlTint,
                diameter: Self.controlDiameter
            )
            CircleActionButton(
                intent: StartNewVoiceConversationIntent(),
                icon: Image(systemName: "waveform"),
                label: "New voice conversation",
                fill: entry.appearance.controlFill,
                tint: entry.appearance.controlTint,
                diameter: Self.controlDiameter
            )
        }
    }

    /// How many conversations are waiting, when that is worth saying.
    ///
    /// The number is `.privacySensitive()` while the glyph beside it is not, so
    /// a locked device still shows that something arrived without spelling out
    /// how far behind its owner is. Counts above two digits collapse to `99+`:
    /// past that the exact figure stops being information and the chip would
    /// grow into the mark.
    @ViewBuilder
    private var unreadChip: some View {
        if let count = entry.unreadCount {
            HStack(spacing: 3) {
                Image(systemName: "bubble.left.fill")
                    .font(.system(size: 9))
                Text(count > 99 ? "99+" : "\(count)")
                    .font(.system(size: 11, weight: .semibold))
                    .privacySensitive()
            }
            .foregroundStyle(WidgetTheme.onBrand)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(WidgetTheme.onBrandFill, in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(count) unread")
        }
    }
}

/// The assistant's face, drawn rather than shipped as an image.
///
/// The product's avatars are composed per assistant from body shapes and eye
/// styles the SPA fetches, and none of that reaches this process: the snapshot
/// carries conversations, not a rendered avatar. So the brand card draws a
/// fixed stand-in built the same way, a rounded body with two googly eyes, out
/// of shapes rather than a bitmap. Shapes stay sharp at every scale and on
/// every display, which is more than a flattened export of a mock would manage,
/// and they cost the extension no asset at all.
private struct QuickActionsAvatar: View {
    let size: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.34, style: .continuous)
            .fill(WidgetTheme.avatarBody)
            .frame(width: size, height: size)
            .overlay {
                HStack(spacing: size * 0.1) {
                    eye
                    eye
                }
            }
            .accessibilityHidden(true)
    }

    /// Pupils sit low in the whites, which is the whole trick: centered dots
    /// read as punctuation, low ones read as a face looking back.
    private var eye: some View {
        Ellipse()
            .fill(WidgetTheme.avatarSclera)
            .frame(width: size * 0.26, height: size * 0.34)
            .overlay(alignment: .bottom) {
                Circle()
                    .fill(WidgetTheme.avatarPupil)
                    .frame(width: size * 0.14, height: size * 0.14)
                    .padding(.bottom, size * 0.06)
            }
    }
}

/// The whole of what an appearance decides: three colors.
private extension QuickActionsAppearance {
    /// The card behind everything.
    var cardSurface: Color {
        switch self {
        case .brand:
            return WidgetTheme.brandCardSurface
        case .light:
            return WidgetTheme.surface
        }
    }

    /// The circle behind an action glyph.
    var controlFill: Color {
        switch self {
        case .brand:
            return WidgetTheme.onBrandFill
        case .light:
            return WidgetTheme.voiceFill
        }
    }

    /// The action glyph itself.
    var controlTint: Color {
        switch self {
        case .brand:
            return WidgetTheme.onBrand
        case .light:
            return WidgetTheme.textPrimary
        }
    }
}
