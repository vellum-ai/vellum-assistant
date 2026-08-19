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
