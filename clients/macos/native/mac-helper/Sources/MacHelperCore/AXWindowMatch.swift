import Foundation

/// Picking the one AX window that is a given window-server window, by title.
///
/// **This exists because an app's AX title is not always the window server's
/// name for the same window.** Chromium appends its own suffix, so a Chrome
/// window the server calls `Some Page` reports an AX title of `Some Page -
/// Google Chrome - Alex (vellum.ai)`. An equality test never fits, and since
/// every maximised window of an app shares one frame, the frame test cannot
/// separate them either: the window ends up resolving to nothing at all.
///
/// The rule stays "exactly one or none". Naming more than one window is the
/// case the caller must refuse, because reading or raising the wrong window
/// beside the right one's screenshot is worse than declining.
public enum AXWindowMatch {
    /// The index of the single window whose title is `serverName`, else of the
    /// single one whose title begins with it, else nil.
    ///
    /// Equality is tried first so an app that titles two windows `Untitled`
    /// and `Untitled 2` still refuses rather than matching the shorter one by
    /// prefix.
    public static func uniqueTitle(serverName: String?, titles: [String?]) -> Int? {
        guard let serverName, !serverName.isEmpty else { return nil }

        if let only = soleIndex(in: titles, where: { $0 == serverName }) {
            return only
        }
        return soleIndex(in: titles, where: { $0.hasPrefix(serverName) })
    }

    private static func soleIndex(in titles: [String?], where fits: (String) -> Bool) -> Int? {
        var found: Int?
        for (index, title) in titles.enumerated() {
            guard let title, fits(title) else { continue }
            if found != nil { return nil }
            found = index
        }
        return found
    }
}
