using Vellum.WindowsHelper.Modules;

namespace Vellum.WindowsHelper.Tests;

public static class CompanionLocatorTests
{
    public static void Run()
    {
        var save = new AutomationNode(1, "button", "Save", null, false, false, false, true, new PixelRect(-500, 100, 80, 40), []);
        var found = CompanionLocator.Find(save, "save");
        Check(found.GetProperty("found").GetBoolean() && found.GetProperty("x").GetInt32() == -500, "unique labels retain physical bounds");
        var tree = save with { Children = [save with { Id = 2 }] };
        Check(CompanionLocator.Find(tree, "Save").GetProperty("reason").GetString() == "ambiguous", "duplicate labels must not guess");
        Check(CompanionLocator.Find(save, "Close").GetProperty("reason").GetString() == "no-match", "missing labels remain unresolved");
        Check(CompanionLocator.Find(null, "Save").GetProperty("reason").GetString() == "no-tree", "inaccessible trees remain unresolved");
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) { throw new Exception(message); }
    }
}
