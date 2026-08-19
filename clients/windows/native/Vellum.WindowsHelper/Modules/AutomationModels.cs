using System.Text.Json;
using System.Text.Json.Serialization;

namespace Vellum.WindowsHelper.Modules;

/// <summary>
/// Wire types for UI Automation observation and screen capture. All bounds are
/// physical pixels in the Windows virtual desktop space (which may have a
/// negative origin); the per-display scale percent converts to logical units.
/// </summary>
public static class AutomationJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static JsonElement ToElement<T>(T value) => JsonSerializer.SerializeToElement(value, Options);

    public static string ToJson<T>(T value) => JsonSerializer.Serialize(value, Options);
}

public sealed record PixelRect(int X, int Y, int Width, int Height);

public sealed record AutomationNode(
    long Id, string Role, string? Name, string? Value, bool Focused, bool Selected,
    bool Editable, bool Enabled, PixelRect Bounds, IReadOnlyList<AutomationNode> Children);

public sealed record ForegroundApp(string Name, int ProcessId, string? WindowTitle);

public sealed record WindowInfo(long Handle, string Title, PixelRect Bounds, bool Foreground);

/// <summary>Structured reason a target could not be observed or captured.</summary>
public sealed record Unavailable(string Code, string Message)
{
    public const string NoForeground = "no_foreground";
    public const string ElevatedOrProtected = "elevated_or_protected";
    public const string NotFound = "not_found";
    public const string CaptureDenied = "capture_denied";
    public const string Offscreen = "offscreen";
}

public sealed record AutomationSnapshot(
    AutomationNode? Tree, ForegroundApp? ForegroundApp,
    IReadOnlyList<WindowInfo> SecondaryWindows, Unavailable? Unavailable);

/// <summary>
/// Observation returned over RPC. Tree, diff, and window lists are JSON
/// strings so the executor wiring can embed them in the string-typed
/// observation fields of the committed host_cu contract.
/// </summary>
public sealed record ObservationResult(
    string Kind, string? Tree, string? Diff, ForegroundApp? ForegroundApp,
    string SecondaryWindows, PixelRect? TargetBounds, Unavailable? Unavailable);

public sealed record TreeDiff(
    IReadOnlyList<AutomationNode> Added, IReadOnlyList<AutomationNode> Changed,
    IReadOnlyList<long> RemovedIds);

public static class AutomationIds
{
    public static long FromRuntimeId(int[]? runtimeId, string fallback)
    {
        var value = runtimeId is null || runtimeId.Length == 0
            ? fallback
            : string.Join('.', runtimeId);
        ulong hash = 14695981039346656037;
        unchecked
        {
            foreach (var character in value)
            {
                hash = (hash ^ character) * 1099511628211;
            }
        }
        var id = (long)(hash & 0x1fffffffffffff);
        return id == 0 ? 1 : id;
    }
}

public static class AutomationTreeDiff
{
    public static TreeDiff Compute(AutomationNode? previous, AutomationNode? next)
    {
        var before = Flatten(previous);
        var after = Flatten(next);
        var added = new List<AutomationNode>();
        var changed = new List<AutomationNode>();
        foreach (var (id, node) in after)
        {
            var target = !before.TryGetValue(id, out var old) ? added : SameState(old, node) ? null : changed;
            target?.Add(node with { Children = [] });
        }
        var removedIds = before.Keys.Where(id => !after.ContainsKey(id)).ToList();
        return new TreeDiff(added, changed, removedIds);
    }

    private static bool SameState(AutomationNode a, AutomationNode b) =>
        a.Role == b.Role && a.Name == b.Name && a.Value == b.Value && a.Focused == b.Focused &&
        a.Selected == b.Selected && a.Editable == b.Editable && a.Enabled == b.Enabled &&
        a.Bounds == b.Bounds;

    private static Dictionary<long, AutomationNode> Flatten(AutomationNode? root)
    {
        var nodes = new Dictionary<long, AutomationNode>();
        var stack = new Stack<AutomationNode>();
        if (root is not null)
        {
            stack.Push(root);
        }
        while (stack.Count > 0)
        {
            var node = stack.Pop();
            nodes[node.Id] = node;
            foreach (var child in node.Children)
            {
                stack.Push(child);
            }
        }
        return nodes;
    }
}
