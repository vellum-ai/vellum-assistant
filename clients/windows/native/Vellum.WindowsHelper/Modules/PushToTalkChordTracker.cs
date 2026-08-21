namespace Vellum.WindowsHelper.Modules;

public enum PushToTalkTransition
{
    None,
    Down,
    Up,
    Pending,
}

public sealed class PushToTalkChordTracker
{
    private HashSet<ushort> _required = [];
    private readonly HashSet<ushort> _pressed = [];

    public bool Active { get; private set; }
    public bool Pending { get; private set; }

    public PushToTalkTransition Configure(IEnumerable<ushort> keys)
    {
        var transition = Active ? PushToTalkTransition.Up : PushToTalkTransition.None;
        _required = [.. keys];
        _pressed.Clear();
        Active = false;
        Pending = false;
        return transition;
    }

    public PushToTalkTransition KeyDown(ushort key)
    {
        if (!_pressed.Add(key) || _required.Count == 0)
        {
            return PushToTalkTransition.None;
        }
        if (!MatchesChord())
        {
            Pending = false;
            return PushToTalkTransition.None;
        }
        // Every chord waits out the hold guard, so a shortcut that shares its
        // prefix (Ctrl+Shift+T over Ctrl+Shift) cancels instead of recording.
        Pending = true;
        return PushToTalkTransition.Pending;
    }

    public PushToTalkTransition ActivatePending()
    {
        if (!Pending || !MatchesChord())
        {
            return PushToTalkTransition.None;
        }
        Pending = false;
        Active = true;
        return PushToTalkTransition.Down;
    }

    public PushToTalkTransition KeyUp(ushort key)
    {
        _pressed.Remove(key);
        if (Pending && !MatchesChord())
        {
            Pending = false;
        }
        if (!Active || !_required.Contains(key))
        {
            return PushToTalkTransition.None;
        }
        Active = false;
        return PushToTalkTransition.Up;
    }

    private bool MatchesChord() =>
        _pressed.Count == _required.Count && _required.All(_pressed.Contains);
}

public readonly record struct PhysicalKeyTransition(ushort Key, bool Down);

public sealed class PhysicalKeyTracker
{
    private readonly HashSet<ushort> _pressed = [];

    public PhysicalKeyTransition? Observe(ushort physicalKey, bool down)
    {
        var normalized = Normalize(physicalKey);
        if (down)
        {
            if (!_pressed.Add(physicalKey))
            {
                return null;
            }
            return _pressed.Count(key => Normalize(key) == normalized) == 1
                ? new PhysicalKeyTransition(normalized, true)
                : null;
        }
        if (!_pressed.Remove(physicalKey))
        {
            return null;
        }
        return _pressed.Any(key => Normalize(key) == normalized)
            ? null
            : new PhysicalKeyTransition(normalized, false);
    }

    private static ushort Normalize(ushort key) => key switch
    {
        0xA0 or 0xA1 => 0x10,
        0xA2 or 0xA3 => 0x11,
        0xA4 or 0xA5 => 0x12,
        0x5C => 0x5B,
        _ => key,
    };
}
