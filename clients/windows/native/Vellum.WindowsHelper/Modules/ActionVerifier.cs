namespace Vellum.WindowsHelper.Modules;

public enum CuVerdict { Allowed, NeedsConfirmation, Blocked }

public sealed record CuVerifyResult(CuVerdict Verdict, string? Reason = null);

// One computer-use action after tool-name mapping; coordinates are physical
// pixels in the Windows virtual-desktop space.
public sealed record CuAction(
    string Type,
    double? X = null, double? Y = null,
    long? ElementId = null,
    double? ToX = null, double? ToY = null, long? ToElementId = null,
    string? Text = null, string? Key = null,
    string? ScrollDirection = null, int? ScrollAmount = null,
    int? WaitDurationMs = null, string? AppName = null, string? Script = null);

// Seam to UI Automation observation and element targeting.
public interface ICuObservationSource
{
    Task<IReadOnlyDictionary<string, object?>> ObserveAsync(
        string conversationId, int stepNumber, CancellationToken cancellationToken);

    Task<CuPoint?> ResolveElementCenterAsync(long elementId, CancellationToken cancellationToken);

    Task<CuPoint> TranslateScreenPointAsync(
        string conversationId, CuPoint point, CancellationToken cancellationToken);
}

public sealed record CuPoint(double X, double Y);

public static class ObservationSeams
{
    public static ICuObservationSource? CuSource { get; set; }

    // Settle, then observe through the registered source.
    public static async Task<Dictionary<string, object?>> SettleAndObserveCuAsync(
        string conversationId, int stepNumber, int settleMs, CancellationToken cancellationToken)
    {
        if (settleMs > 0)
        {
            await Task.Delay(settleMs, cancellationToken);
        }
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        if (CuSource is { } source)
        {
            foreach (var (key, value) in await source.ObserveAsync(conversationId, stepNumber, cancellationToken))
            {
                result[key] = value;
            }
        }
        return result;
    }
}

// Per-conversation safety state: step limit, loop detection, destructive-key
// and form-submission confirmation. Mirrors the macOS helper's checks with
// Windows key equivalents.
public sealed class ActionVerifier(int maxSteps = 50)
{
    private const int LoopWindowSize = 10;
    private const double CoordinateTolerance = 5;
    private static readonly HashSet<string> ClickTypes =
        new(["click", "double_click", "right_click"], StringComparer.Ordinal);
    private static readonly HashSet<string> DestructiveKeys = new(
        ["alt+f4", "ctrl+w", "ctrl+f4", "cmd+q", "command+q", "cmd+w", "command+w"],
        StringComparer.Ordinal);

    private readonly List<CuAction> _history = [];

    public CuVerifyResult Verify(CuAction action)
    {
        if (_history.Count >= maxSteps)
        {
            return new(CuVerdict.Blocked, $"Maximum step limit ({maxSteps}) reached");
        }
        if (DetectLoop(action))
        {
            return new(CuVerdict.Blocked, "Agent appears stuck in a repeating action loop");
        }
        if (action.Type == "key" && action.Key is { } rawKey)
        {
            var key = CanonicalizeChord(rawKey);
            if (DestructiveKeys.Contains(key))
            {
                return new(CuVerdict.NeedsConfirmation, $"Key combo '{key}' could close a window or delete content");
            }
            if (key is "enter" or "return" && _history is [.., { Type: "type_text" }])
            {
                return new(CuVerdict.NeedsConfirmation, "Pressing Enter may submit a form");
            }
        }
        _history.Add(action);
        return new(CuVerdict.Allowed);
    }

    // Chord components are trimmed and lowercased with the same split semantics
    // KeyPlanner.ParseChord uses, so "ALT + F4" and "alt+f4" compare equal.
    private static string CanonicalizeChord(string key) =>
        string.Join(
            '+',
            key.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(part => part.ToLowerInvariant()));

    // Repeating patterns in a sliding window: the same action three times in a
    // row, or a 2-4 action cycle repeated twice.
    private bool DetectLoop(CuAction candidate)
    {
        var window = _history.TakeLast(LoopWindowSize - 1).Append(candidate).ToArray();
        if (window.Length >= 3 && window[^3..].All(action => ActionsMatch(action, window[^3])))
        {
            return true;
        }
        for (var cycle = 2; cycle <= 4; cycle++)
        {
            var needed = cycle * 2;
            if (window.Length >= needed &&
                Enumerable.Range(0, cycle).All(i =>
                    ActionsMatch(window[^(needed - i)], window[^(cycle - i)])))
            {
                return true;
            }
        }
        return false;
    }

    private static bool ActionsMatch(CuAction a, CuAction b)
    {
        if (a.Type != b.Type || a.Text != b.Text || a.Key != b.Key ||
            a.AppName != b.AppName || a.Script != b.Script)
        {
            return false;
        }
        if (ClickTypes.Contains(a.Type))
        {
            // Radial proximity so near-identical clicks still count as repeats.
            return (a.X, a.Y, b.X, b.Y) switch
            {
                (double ax, double ay, double bx, double by) =>
                    Math.Sqrt(Math.Pow(ax - bx, 2) + Math.Pow(ay - by, 2)) <= CoordinateTolerance,
                (null, null, null, null) => true,
                _ => false,
            };
        }
        return a.X == b.X && a.Y == b.Y && a.ToX == b.ToX && a.ToY == b.ToY;
    }
}

// Per-conversation verifier store with idle eviction, so abandoned sessions
// cannot accumulate state forever.
public static class CuSessionStore
{
    private static readonly TimeSpan SessionTtl = TimeSpan.FromSeconds(600);
    private static readonly Dictionary<string, (ActionVerifier Verifier, DateTime LastAccess)> Sessions =
        new(StringComparer.Ordinal);
    private static readonly Lock Gate = new();

    public static ActionVerifier Touch(string conversationId)
    {
        lock (Gate)
        {
            var now = DateTime.UtcNow;
            foreach (var stale in Sessions.Where(entry => now - entry.Value.LastAccess > SessionTtl).ToList())
            {
                Sessions.Remove(stale.Key);
            }
            var verifier = Sessions.TryGetValue(conversationId, out var entry)
                ? entry.Verifier
                : new ActionVerifier();
            Sessions[conversationId] = (verifier, now);
            return verifier;
        }
    }

    public static void Clear(string conversationId)
    {
        lock (Gate)
        {
            _ = Sessions.Remove(conversationId);
        }
    }
}
