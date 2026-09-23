using System.Text.Json;

namespace Vellum.WindowsHelper.Modules;

public static class CompanionLocator
{
    public static JsonElement Find(AutomationNode? tree, string query)
    {
        if (tree is null)
        {
            return AutomationJson.ToElement(new { found = false, reason = "no-tree" });
        }
        var nodes = AutomationTree.Flatten(tree).Values.Where(node => !string.IsNullOrWhiteSpace(node.Name) && node.Bounds.Width > 0 && node.Bounds.Height > 0).ToList();
        var matches = nodes.Where(node => string.Equals(node.Name?.Trim(), query.Trim(), StringComparison.OrdinalIgnoreCase)).ToList();
        if (matches.Count != 1)
        {
            var candidates = matches.Count > 1 ? matches : nodes;
            var labels = candidates.Select(node => node.Name!).Distinct().ToList();
            return AutomationJson.ToElement(new {
                found = false,
                reason = matches.Count > 1 ? "ambiguous" : "no-match",
                ambiguous = matches.Count > 1 ? labels.Take(24).ToArray() : null,
                available = matches.Count == 0 ? labels.Take(24).ToArray() : null,
                candidateCount = labels.Count,
            });
        }
        var match = matches[0];
        return AutomationJson.ToElement(new { found = true, label = match.Name, role = match.Role,
            x = match.Bounds.X, y = match.Bounds.Y, width = match.Bounds.Width, height = match.Bounds.Height });
    }

}
