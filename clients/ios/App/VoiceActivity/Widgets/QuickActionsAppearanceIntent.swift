import AppIntents

/// How the Quick Actions widget paints itself.
///
/// The two looks are the same widget, not two widgets. Both lead with camera
/// and voice, and they differ in which Home Screen they disappear into: the
/// brand card is a saturated green block that reads as a Vellum tile, the light
/// card is the quiet system surface the other Vellum widgets sit on, which
/// follows the device appearance and so is dark on a dark Home Screen. The
/// light card also carries a Chat button, because it spends on a pill the width
/// the brand card gives the mark; on the brand card a tap outside the two
/// circles opens the app instead. The choice is brand block or system card, not
/// a second theme switch. Shipping the two as one configurable entry keeps the
/// widget gallery honest, where two near-identical rows would just make the
/// user guess.
enum QuickActionsAppearance: String, AppEnum {
    case brand
    case light

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Appearance"

    static var caseDisplayRepresentations: [QuickActionsAppearance: DisplayRepresentation] = [
        .brand: "Brand",
        .light: "Light",
    ]
}

/// The configuration behind the Quick Actions widget, carrying the one choice
/// the user makes in Edit Widget.
///
/// A `WidgetConfigurationIntent` needs no `perform()`: nothing runs it. The
/// system stores the chosen parameters and hands them back to the timeline
/// provider on every reload, which is the whole job.
struct QuickActionsAppearanceIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Quick Actions"

    static var description = IntentDescription(
        "Choose whether the Quick Actions widget uses the brand or the light card."
    )

    @Parameter(title: "Appearance", default: .brand)
    var appearance: QuickActionsAppearance
}
