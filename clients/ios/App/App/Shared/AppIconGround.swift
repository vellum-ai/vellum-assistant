import SwiftUI
import UIKit

/// The ground this build's app icon is drawn on, resolved from its own bundle
/// rather than hardcoded.
///
/// Each environment sets `APP_ICON_GROUND` in its xcconfig to the same
/// `fill.solid` its Icon Composer bundle declares, and the three are not the
/// same color: production is green, Staging yellow, Dev pink. A literal here
/// would paint the production green onto every build, so a Dev widget would
/// advertise an icon the Dev app does not have. Same argument as
/// ``BundleURLScheme``, which is why it is resolved the same way.
///
/// The value is the icon's own string, `display-p3:R,G,B,A`, carried across
/// verbatim so the two can be compared without either side rounding first.
/// P3 components are handed straight to `UIColor`, which takes them in that
/// space, so the color the widget draws is the color the icon declares.
///
/// Lives in `Shared/` because the widgets that draw the mark are code in the
/// appex.
enum AppIconGround {
    /// Info.plist key carrying the ground, populated from `$(APP_ICON_GROUND)`.
    static let infoPlistKey = "VellumAppIconGround"

    /// The ground for the currently running bundle, or `nil` when the bundle
    /// declares none or declares one this cannot read.
    ///
    /// Optional for the reason ``BundleURLScheme/current`` is, softened by what
    /// is at stake: this is a tint rather than a destination, so a caller that
    /// cannot resolve it draws its own fallback rather than dropping the mark.
    static var current: Color? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: infoPlistKey) as? String else {
            return nil
        }
        return color(fromIconFill: raw)
    }

    /// Parses Icon Composer's `display-p3:R,G,B,A`. Returns `nil` for any other
    /// spelling, including the unsubstituted `$(APP_ICON_GROUND)` a target
    /// missing the setting would carry.
    static func color(fromIconFill raw: String) -> Color? {
        let parts = raw.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0] == "display-p3" else {
            return nil
        }
        let components = parts[1].split(separator: ",").compactMap { Double($0) }
        guard components.count == 4 else {
            return nil
        }
        return Color(
            uiColor: UIColor(
                displayP3Red: components[0],
                green: components[1],
                blue: components[2],
                alpha: components[3]
            )
        )
    }
}
