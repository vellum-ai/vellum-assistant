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

    public bool Consumes(ushort key) => _required.Contains(key);

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
        if (_required.Count > 1)
        {
            Active = true;
            return PushToTalkTransition.Down;
        }
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

public static class PushToTalkKeyPlanner
{
    public static ushort ResolveKey(string label) => label switch
    {
        " " or "Spacebar" => 0x20,
        ")" => 0x30,
        "!" => 0x31,
        "@" => 0x32,
        "#" => 0x33,
        "$" => 0x34,
        "%" => 0x35,
        "^" => 0x36,
        "&" => 0x37,
        "*" => 0x38,
        "(" => 0x39,
        "ArrowUp" => 0x26,
        "ArrowDown" => 0x28,
        "ArrowLeft" => 0x25,
        "ArrowRight" => 0x27,
        ";" or ":" => 0xBA,
        "=" or "+" => 0xBB,
        "," or "<" => 0xBC,
        "-" or "_" => 0xBD,
        "." or ">" => 0xBE,
        "/" or "?" => 0xBF,
        "`" or "~" => 0xC0,
        "[" or "{" => 0xDB,
        "\\" or "|" => 0xDC,
        "]" or "}" => 0xDD,
        "'" or "\"" => 0xDE,
        _ => KeyPlanner.ResolveKey(label),
    };
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

    public static ushort Normalize(ushort key) => key switch
    {
        0xA0 or 0xA1 => 0x10,
        0xA2 or 0xA3 => 0x11,
        0xA4 or 0xA5 => 0x12,
        0x5C => 0x5B,
        _ => key,
    };
}
