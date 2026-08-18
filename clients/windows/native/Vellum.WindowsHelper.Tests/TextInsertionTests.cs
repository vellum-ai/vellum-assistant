using System.Text.Json;
using Vellum.WindowsHelper.Modules;

public static class TextInsertionTests
{
    public static async Task RunAsync()
    {
        await ProtectedFieldIsRefusedAsync();
        await UnknownFocusIsRefusedAsync();
        await PasteRestoresClipboardWhenStillHoldingInsertedTextAsync();
        await PasteLeavesClipboardWhenTargetReplacedItAsync();
        await FailedPasteRestoresClipboardAndBlocksAsync();
        await MissingTextParameterIsBlockedAsync();
        PermissionMappings();
        Console.WriteLine("Text insertion tests passed");
    }

    private static async Task ProtectedFieldIsRefusedAsync()
    {
        var host = new FakeHost { ProtectedField = true };
        var outcome = await new TextInsertion(host).InsertAsync("secret", CancellationToken.None);
        Assert(outcome.Status == "blocked" && outcome.Reason == "protected-field");
        Assert(host.WrittenTexts.Count == 0);
    }

    private static async Task UnknownFocusIsRefusedAsync()
    {
        var host = new FakeHost { ProtectedField = null };
        var outcome = await new TextInsertion(host).InsertAsync("hello", CancellationToken.None);
        Assert(outcome.Status == "blocked" && outcome.Reason == "focus-unknown");
        Assert(host.WrittenTexts.Count == 0);
    }

    private static async Task PasteRestoresClipboardWhenStillHoldingInsertedTextAsync()
    {
        var snapshot = new ClipboardSnapshot([new ClipboardEntry(13, [1, 2])]);
        var host = new FakeHost { Snapshot = snapshot };
        var outcome = await new TextInsertion(host).InsertAsync("héllo 🙂", CancellationToken.None);
        Assert(outcome.Status == "inserted");
        Assert(host.WrittenTexts is ["héllo 🙂"]);
        Assert(host.RestoredSnapshots is [var restored] && restored == snapshot);
    }

    private static async Task PasteLeavesClipboardWhenTargetReplacedItAsync()
    {
        var host = new FakeHost { ClipboardTextAfterPaste = "the target app copied this" };
        var outcome = await new TextInsertion(host).InsertAsync("hello", CancellationToken.None);
        Assert(outcome.Status == "inserted");
        Assert(host.RestoredSnapshots.Count == 0);
    }

    private static async Task FailedPasteRestoresClipboardAndBlocksAsync()
    {
        var host = new FakeHost { PasteSucceeds = false };
        var outcome = await new TextInsertion(host).InsertAsync("hello", CancellationToken.None);
        Assert(outcome.Status == "blocked" && outcome.Reason == "paste-failed");
        Assert(host.RestoredSnapshots.Count == 1);
    }

    private static async Task MissingTextParameterIsBlockedAsync()
    {
        using var request = JsonDocument.Parse("{\"other\":true}");
        var result = await new TextInsertion(new FakeHost()).InvokeAsync(
            TextInsertion.InsertMethod,
            request.RootElement,
            CancellationToken.None);
        Assert(result is InsertionOutcome { Status: "blocked", Reason: "missing-text" });
    }

    private static void PermissionMappings()
    {
        Assert(PermissionService.MapMicrophoneConsent("Allow", "Allow") == "granted");
        Assert(PermissionService.MapMicrophoneConsent("Allow", null) == "granted");
        Assert(PermissionService.MapMicrophoneConsent("Allow", "Deny") == "denied");
        Assert(PermissionService.MapMicrophoneConsent("Deny", "Allow") == "denied");
        Assert(PermissionService.MapMicrophoneConsent(null, null) == "unknown");
        Assert(PermissionService.MapOnlineSpeech(1) == "granted");
        Assert(PermissionService.MapOnlineSpeech(0) == "denied");
        Assert(PermissionService.MapOnlineSpeech(null) == "not-determined");
        Assert(PermissionService.MapToastEnabled(0) == "denied");
        Assert(PermissionService.MapToastEnabled(1) == "granted");
        Assert(PermissionService.MapToastEnabled(null) == "granted");
    }

    private static void Assert(bool condition)
    {
        if (!condition)
        {
            throw new Exception("Text insertion assertion failed");
        }
    }

    private sealed class FakeHost : ITextInsertionHost
    {
        public bool? ProtectedField { get; init; } = false;
        public ClipboardSnapshot Snapshot { get; init; } = ClipboardSnapshot.Empty;
        public bool PasteSucceeds { get; init; } = true;
        public string? ClipboardTextAfterPaste { get; init; }
        public List<string> WrittenTexts { get; } = [];
        public List<ClipboardSnapshot> RestoredSnapshots { get; } = [];

        public bool? IsFocusedFieldProtected() => ProtectedField;

        public ClipboardSnapshot SnapshotClipboard() => Snapshot;

        public void RestoreClipboard(ClipboardSnapshot snapshot) =>
            RestoredSnapshots.Add(snapshot);

        public bool WriteClipboardText(string text)
        {
            WrittenTexts.Add(text);
            return true;
        }

        public string? ReadClipboardText() =>
            ClipboardTextAfterPaste ?? WrittenTexts.LastOrDefault();

        public bool SendPasteChord() => PasteSucceeds;

        public Task DelayAsync(int milliseconds, CancellationToken cancellationToken) =>
            Task.CompletedTask;
    }
}
