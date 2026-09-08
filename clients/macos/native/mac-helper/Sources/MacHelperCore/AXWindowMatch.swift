import Foundation

/// Picking the one AX window that is a given window-server window, by title.
///
/// **This exists because an app's AX title is not always the window server's
/// name for the same window.** Chromium appends its own suffix, so a Chrome
/// window the server calls `Some Page` reports an AX title of `Some Page -
/// Google Chrome - Alice (example.com)`. An equality test never fits, and
/// since every maximised window of an app shares one frame, the frame test
/// cannot separate them either: the window resolves to nothing at all.
///
/// The rule stays "exactly one or none". Naming more than one window is the
/// case the caller must refuse, because reading or raising the wrong window
/// beside the right one's screenshot is worse than declining.
public enum AXWindowMatch {
    /// How much the frame has already narrowed the candidates.
    public enum Candidates {
        /// Several windows sit at the requested frame, and the title is all
        /// that separates them.
        case sharingOneFrame
        /// No window sits at that frame, so these are every window the app
        /// has and the title is the only thing that has been asked at all.
        case everyWindow
    }

    /// The index of the single window `serverName` names, or nil.
    ///
    /// Which of the two forms an app gives a window is not something this side
    /// can tell, so among windows that share a frame an exact title and a
    /// decorated one count **together**: either could be the window asked for,
    /// which makes one beside the other an ambiguity rather than a preference.
    /// This is the rule the Chrome tab picker already follows
    /// (`companion-capture-sources.ts`).
    ///
    /// With no frame to go on, equality is tried first, so an app that titles
    /// two windows `Untitled` and `Untitled 2` resolves the first rather than
    /// refusing both.
    public static func uniqueTitle(
        serverName: String?,
        titles: [String?],
        candidates: Candidates = .everyWindow
    ) -> Int? {
        guard let serverName, !serverName.isEmpty else { return nil }

        let isExact: (String) -> Bool = { $0 == serverName }
        let isDecorated: (String) -> Bool = { $0.hasPrefix(serverName) }
        let isElided = elidedMatcher(for: serverName)

        switch candidates {
        case .sharingOneFrame:
            return soleIndex(in: titles) {
                isExact($0) || isDecorated($0) || isElided($0)
            }
        case .everyWindow:
            if let only = soleIndex(in: titles, where: isExact) {
                return only
            }
            if let only = soleIndex(in: titles, where: isDecorated) {
                return only
            }
            return soleIndex(in: titles, where: isElided)
        }
    }

    /// Matches a title against a name the window server shortened.
    ///
    /// A long title comes back from the server with its middle replaced by an
    /// ellipsis, so neither equality nor a prefix can ever fit: what is left is
    /// the beginning and the end of the real title with a hole between them.
    /// A candidate fits when it starts with the part before the hole and still
    /// contains the part after it, past the head rather than anywhere in it.
    ///
    /// Names the server did not shorten match nothing here, so the caller's
    /// other comparisons decide them.
    private static func elidedMatcher(for serverName: String) -> (String) -> Bool {
        guard let hole = serverName.firstIndex(of: "\u{2026}") else {
            return { _ in false }
        }
        let head = String(serverName[serverName.startIndex..<hole])
        let tail = String(serverName[serverName.index(after: hole)...])
        // A hole at one end leaves only one side to check, and a name that is
        // nothing but the ellipsis names every window, so it names none.
        guard !head.isEmpty || !tail.isEmpty else {
            return { _ in false }
        }
        return { title in
            guard title.hasPrefix(head) else { return false }
            guard !tail.isEmpty else { return true }
            // Past the head, never inside it. The two ends of a shortened name
            // can repeat ("2026 Report...2026"), and a tail satisfied by the
            // head would fit a window whose real tail is something else.
            return title[title.index(title.startIndex, offsetBy: head.count)...]
                .contains(tail)
        }
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
