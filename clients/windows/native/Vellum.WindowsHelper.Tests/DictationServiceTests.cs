using Vellum.WindowsHelper.Modules;

/// <summary>
/// Behavior tests for the dictation session state machine, using fake
/// engines instead of System.Speech.
/// </summary>
public static class DictationServiceTests
{
    private sealed class FakeEngine : IDictationEngine
    {
        public string Tap => "fake";

        public bool Finished;
        public bool Cancelled;
        public bool Disposed;
        public readonly List<byte[]> Chunks = [];
        public Exception? StartError;

        public event Action<string>? Partial;
        public event Action<string>? Finalized;
        public event Action<string>? Failed;

        public void Start()
        {
            if (StartError is not null)
            {
                throw StartError;
            }
        }

        public void Append(byte[] pcm) => Chunks.Add(pcm);

        public void Finish()
        {
            Finished = true;
            Finalized?.Invoke("final text");
        }

        public void Cancel() => Cancelled = true;

        public void Dispose() => Disposed = true;

        public void EmitPartial(string text) => Partial?.Invoke(text);

        public void EmitFailure(string message) => Failed?.Invoke(message);
    }

    public static void Run()
    {
        var events = new List<(string Method, string Json)>();
        void Notify(string method, object parameters) =>
            events.Add((method, System.Text.Json.JsonSerializer.Serialize(parameters)));
        static string Json(object value) =>
            System.Text.Json.JsonSerializer.Serialize(value);

        // Unavailable engines (denied mic, missing language) refuse enablement.
        var denied = new DictationSessionManager(
            _ => throw new DictationUnavailableException("microphone access denied"),
            Notify);
        Assert(Json(denied.SetPartials(true, true, 16000))
            .Contains("microphone access denied", StringComparison.Ordinal));

        // Streaming session: start, partials, pushed audio, graceful stop.
        FakeEngine engine = new();
        var manager = new DictationSessionManager(_ => engine, Notify);
        Assert(Json(manager.SetPartials(true, true, 16000))
            .Contains("\"tap\":\"fake\"", StringComparison.Ordinal));
        engine.EmitPartial("hello");
        manager.AppendAudio(Convert.ToBase64String(new byte[] { 1, 2 }));
        Assert(engine.Chunks.Count == 1);
        manager.SetPartials(false, false, 16000);
        Assert(engine.Finished);
        Assert(events.Any(e => e.Method == "dictation.partial" &&
            e.Json.Contains("hello", StringComparison.Ordinal)));
        Assert(events.Any(e => e.Method == "dictation.finalized" &&
            e.Json.Contains("final text", StringComparison.Ordinal)));

        // Device loss mid-session surfaces dictation.error, not finalized.
        events.Clear();
        engine = new FakeEngine();
        Assert(Json(manager.SetPartials(true, false, 16000))
            .Contains("\"enabled\":true", StringComparison.Ordinal));
        engine.EmitFailure("audio device lost");
        Assert(events.Any(e => e.Method == "dictation.error" &&
            e.Json.Contains("audio device lost", StringComparison.Ordinal)));
        Assert(!events.Any(e => e.Method == "dictation.finalized"));
        Assert(SpinWait.SpinUntil(() => engine.Disposed, TimeSpan.FromSeconds(1)));
        manager.AppendAudio(Convert.ToBase64String(new byte[] { 3, 4 }));
        Assert(engine.Chunks.Count == 0);

        // Restarting cancels the replaced session: it is torn down and its
        // late events are dropped without a finalized transcript.
        events.Clear();
        var first = engine = new FakeEngine();
        manager.SetPartials(true, true, 16000);
        engine = new FakeEngine();
        manager.SetPartials(true, true, 16000);
        Assert(first.Cancelled && first.Disposed);
        first.EmitPartial("stale");
        engine.EmitPartial("fresh");
        Assert(!events.Any(e => e.Json.Contains("stale", StringComparison.Ordinal)));
        Assert(events.Any(e => e.Json.Contains("fresh", StringComparison.Ordinal)));

        // A failed replacement reports a reason and settles the displaced owner.
        events.Clear();
        engine = new FakeEngine { StartError = new Exception("audio device unavailable") };
        Assert(Json(manager.SetPartials(true, false, 16000))
            .Contains("audio device unavailable", StringComparison.Ordinal));
        Assert(events.Any(e => e.Method == "dictation.error" &&
            e.Json.Contains("audio device unavailable", StringComparison.Ordinal)));

        Console.WriteLine("Dictation tests passed");
    }

    private static void Assert(bool condition)
    {
        if (!condition)
        {
            throw new Exception("Dictation test assertion failed");
        }
    }
}
