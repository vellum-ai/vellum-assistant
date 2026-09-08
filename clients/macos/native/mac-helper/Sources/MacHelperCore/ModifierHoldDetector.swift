/// Distills the raw keyboard stream into holds of one configured set of
/// modifiers, with nothing else involved.
///
/// A hold begins when every modifier in the set is down, no modifier outside it
/// is, and no ordinary key is; it ends when any of those stops being true. The
/// verdict is known at press, which is what separates this from
/// `FnTapDetector`: a tap is only a tap once it has been released, but a hold
/// is a hold while it is being held, and the caller needs the opening edge to
/// open a microphone with.
///
/// A hold disqualified mid-way ends rather than pausing. Holding the set and
/// then pressing a key is someone else's shortcut passing through (Ctrl+Option
/// is VoiceOver's own modifier, and macOS claims Ctrl+Option+F and friends), so
/// the hold closes and does not reopen when the extra key lifts. Only a fresh
/// press of the set can start another one.
///
/// Pure state machine, fed by the caller with pre-masked booleans. Latched
/// modifier state (Caps Lock, Num Lock) must not be included in
/// `extraModifiersHeld`: it stays set for whole sessions and would permanently
/// disqualify every hold.
public struct ModifierHoldDetector {
    /// Why a hold closed. A consumer reading the span as a gesture needs the
    /// difference: a set that came back up on its own may have been a tap,
    /// while a chord passing through the held state never was one.
    public enum UpReason: String, Equatable, Sendable {
        /// The set was released with nothing else involved.
        case released
        /// A key or a modifier outside the set joined, so the press is a
        /// shortcut on its way somewhere else.
        case chord
        /// Closed by the caller, because the binding went away underneath it.
        case cancelled
    }

    public enum Edge: Equatable, Sendable {
        case down
        case up(UpReason)
    }

    /// Whether a hold is open, which is what an `up` is owed to.
    private var open = false
    /// Whether this press of the set is spent.
    ///
    /// A hold that ends while any of the set is still down stays ended: the
    /// user is holding modifiers they have already spent on something else,
    /// and reopening the moment the extra key lifts would open a microphone in
    /// the middle of their shortcut.
    ///
    /// Cleared only once the whole set is up, which for a set of more than one
    /// is a stricter test than the set no longer being held: Ctrl+Option stops
    /// being held the moment either of them lifts, and clearing there would let
    /// a press of the one that lifted reopen a hold the other is still
    /// mid-shortcut on.
    private var spent = false

    public init() {}

    /// Feed a modifier-flags change. Returns the edges to report, in order.
    ///
    /// `targetHeld` is whether every modifier of the configured set is down and
    /// `anyTargetHeld` whether any of it is, which differ for a set of more
    /// than one and are the difference between a hold ending and the set being
    /// released. `extraModifiersHeld` is whether any modifier outside the set
    /// is down. All three are the caller's to mask, so this type never learns
    /// which modifiers it watches.
    ///
    /// `ordinaryKeyHeld` answers whether any non-modifier key is down right
    /// now, and is consulted only when a hold would open: a key pressed before
    /// the modifiers (Delete held, then Ctrl+Option) is invisible both to the
    /// flags and to the key-down events that follow, so the opening has to ask.
    /// Deliberately a closure so the caller's poll runs only then.
    public mutating func flagsChanged(
        targetHeld: Bool,
        anyTargetHeld: Bool,
        extraModifiersHeld: Bool,
        ordinaryKeyHeld: () -> Bool = { false }
    ) -> [Edge] {
        let qualifies = targetHeld && !extraModifiersHeld

        if open {
            guard qualifies else {
                open = false
                spent = anyTargetHeld
                return [.up(extraModifiersHeld ? .chord : .released)]
            }
            return []
        }

        if !anyTargetHeld {
            spent = false
        }
        guard targetHeld, !spent else {
            return []
        }
        guard qualifies && !ordinaryKeyHeld() else {
            spent = true
            return []
        }
        open = true
        return [.down]
    }

    /// Feed a non-modifier key press. A key pressed during a hold makes it a
    /// chord, which belongs to whatever the user is actually working in.
    public mutating func keyDown() -> [Edge] {
        guard open else {
            return []
        }
        open = false
        spent = true
        return [.up(.chord)]
    }

    /// Close an open hold because the world changed underneath it: the helper
    /// is shutting down, the binding was cleared, or the monitor stopped
    /// delivering. Silent when nothing is open, so it is safe to call anywhere.
    public mutating func cancel() -> [Edge] {
        guard open else {
            return []
        }
        open = false
        // The set may still be physically down, and the reason this hold ended
        // has not gone away with it, so it takes a fresh press to start
        // another. Cancelling nothing changes nothing.
        spent = true
        return [.up(.cancelled)]
    }
}
