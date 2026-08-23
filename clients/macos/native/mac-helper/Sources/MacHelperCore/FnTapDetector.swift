/// Distills the raw keyboard stream into bare-Fn taps.
///
/// A tap is a press and release of Fn with nothing else involved: no other
/// modifier held at any moment of the hold, and no ordinary key already
/// down at the press or pressed during it.
/// Anything else is a chord that belongs to someone else's shortcut on its
/// way through (Fn+Ctrl window tiling, Fn+arrow paging), so reporting it
/// would steal a binding the user never gave us.
///
/// Because a chord can form after Fn goes down (Fn pressed a few
/// milliseconds before Ctrl), the verdict is only known at release. The
/// detector therefore emits nothing at press time: a clean release yields a
/// `down`/`up` pair, and a disqualified hold yields at most a stray `up`
/// (which closes a hold a press-time detector may have opened; see the
/// exact-match hotkey fallback in the executable).
///
/// Pure state machine, fed by the caller with pre-masked booleans. Latched
/// modifier state (Caps Lock, Num Lock) must not be included in
/// `otherModifiersHeld`: it stays set for whole sessions and would
/// permanently disqualify every tap.
public struct FnTapDetector {
    public enum Edge: String, Equatable, Sendable {
        case down
        case up
    }

    private var fnHeld = false
    /// Held alone since the press with nothing else seen; release = tap.
    /// Only a press transition can arm, so a hold disqualified by a chord
    /// stays disqualified even after the other keys release first.
    private var armed = false

    public init() {}

    /// Feed a modifier-flags change. Returns the edges to report, in order.
    ///
    /// `ordinaryKeyHeld` answers whether any non-modifier key is down right
    /// now, and is consulted only on the press transition: a chord whose
    /// ordinary key came first (Delete held, then Fn) is invisible both to
    /// the flags and to key-down events during the hold, so the press has to
    /// ask. Deliberately a closure so the caller's poll runs only then, not
    /// on every modifier event.
    public mutating func flagsChanged(
        fnHeld nowHeld: Bool,
        otherModifiersHeld: Bool,
        ordinaryKeyHeld: () -> Bool = { false }
    ) -> [Edge] {
        let wasHeld = fnHeld
        fnHeld = nowHeld

        if !nowHeld {
            guard wasHeld else {
                return []
            }
            let completedTap = armed
            armed = false
            return completedTap ? [.down, .up] : [.up]
        }

        if !wasHeld {
            armed = !otherModifiersHeld && !ordinaryKeyHeld()
            return []
        }

        if otherModifiersHeld && armed {
            armed = false
            return [.up]
        }
        return []
    }

    /// Feed a non-modifier key press. A key pressed while Fn is held makes
    /// the hold a chord (Fn+Delete, Fn+arrow), never a tap.
    public mutating func keyDown() -> [Edge] {
        guard armed else {
            return []
        }
        armed = false
        return [.up]
    }
}
