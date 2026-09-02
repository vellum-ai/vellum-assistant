namespace Vellum.WindowsHelper.Modules;

/// <summary>
/// Detects a completed clean tap of the configured chord: every chord key
/// pressed (and nothing else), then a chord key released with no other key
/// event in between. Mirrors the renderer's focused-window tap listener, so
/// a shortcut passing through the chord's keys (Alt+Tab, Ctrl+C over a Ctrl
/// binding) disarms instead of toggling.
/// </summary>
public sealed class ChordTapTracker
{
    private HashSet<ushort> _required = [];
    private readonly HashSet<ushort> _pressed = [];

    public bool Armed { get; private set; }

    public void Configure(IEnumerable<ushort> keys)
    {
        _required = [.. keys];
        _pressed.Clear();
        Armed = false;
    }

    public void KeyDown(ushort key)
    {
        if (!_pressed.Add(key) || _required.Count == 0)
        {
            return;
        }
        // Arm on the keydown that completes the exact chord; any other key on
        // the way disarms, and a re-match (release one chord key, press it
        // again) re-arms.
        Armed = MatchesChord();
    }

    /// <summary>Returns true when this release completes a clean tap.</summary>
    public bool KeyUp(ushort key)
    {
        var completesTap = Armed && _required.Contains(key);
        _pressed.Remove(key);
        if (completesTap)
        {
            Armed = false;
        }
        return completesTap;
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
