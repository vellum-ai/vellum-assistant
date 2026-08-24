using System.Globalization;
using System.Speech.AudioFormat;
using System.Speech.Recognition;
using System.Text.Json;
using Vellum.WindowsHelper.Rpc;

namespace Vellum.WindowsHelper.Modules;

/// <summary>
/// Streaming and one-shot dictation over the same JSON-RPC surface as the
/// macOS helper. Audio is pushed by the renderer as base64 16 kHz mono
/// Int16 LE PCM; without pushed audio the recognizer taps the system default
/// input device. Audio and transcripts only ever live in memory.
/// </summary>
public sealed class DictationService : IRpcModule, IDictationSink
{
    private readonly DictationSessionManager _manager = new(
        request => new SystemSpeechEngine(request),
        HelperNotifications.Emit);

    public string CapabilityId => "dictation";

    public IReadOnlyCollection<string> Methods { get; } = [
        "dictation.setPartials",
        "dictation.appendAudio",
        "dictation.transcribe",
    ];

    public ValueTask<object?> InvokeAsync(
        string method, JsonElement? parameters, CancellationToken cancellationToken)
    {
        // Malformed params throw and surface as JSON-RPC internal errors.
        object result = method switch
        {
            "dictation.setPartials" => _manager.SetPartials(
                Prop(parameters, "enable")?.ValueKind == JsonValueKind.True,
                Prop(parameters, "pushAudio")?.ValueKind == JsonValueKind.True,
                Prop(parameters, "sampleRate")?.GetInt32() ?? 16000),
            "dictation.appendAudio" => _manager.AppendAudio(
                Prop(parameters, "audio")?.GetString() ?? ""),
            "dictation.transcribe" => _manager.Transcribe(
                Prop(parameters, "audio")?.GetString() ?? "",
                Prop(parameters, "sampleRate")?.GetInt32() ?? 16000,
                Prop(parameters, "requestId")?.GetString() ?? ""),
            _ => throw new RpcMethodNotFoundException(method),
        };
        return ValueTask.FromResult<object?>(result);
    }

    private static JsonElement? Prop(JsonElement? parameters, string name) =>
        parameters?.TryGetProperty(name, out var value) == true ? value : null;
}

public sealed class DictationUnavailableException(string reason)
    : Exception(reason);

public sealed record DictationEngineRequest(bool PushAudio, int SampleRate);

/// <summary>Recognition engine seam so session behavior is testable.</summary>
public interface IDictationEngine : IDisposable
{
    string Tap { get; }

    event Action<string>? Partial;
    event Action<string>? Finalized;
    event Action<string>? Failed;

    void Start();
    void Append(byte[] pcm);
    void Finish(TimeSpan completionTimeout);
    void Cancel();
}

/// <summary>
/// Session state machine. A generation counter guards engine callbacks so
/// a replaced or cancelled session can never emit into its successor.
/// </summary>
public sealed class DictationSessionManager(
    Func<DictationEngineRequest, IDictationEngine> engineFactory,
    Action<string, object> notify)
{
    private static readonly TimeSpan StreamingCompletionTimeout =
        TimeSpan.FromSeconds(3);
    private static readonly TimeSpan TranscriptionCompletionGrace =
        TimeSpan.FromSeconds(3);

    private readonly object _gate = new();
    private IDictationEngine? _engine;
    private int _generation;
    private IDictationEngine? _transcriptionEngine;
    private int _transcriptionGeneration;

    public object SetPartials(bool enable, bool pushAudio, int sampleRate)
    {
        lock (_gate)
        {
            if (!enable)
            {
                // Graceful stop: let recognition drain into `finalized`.
                _engine?.Finish(StreamingCompletionTimeout);
                _engine = null;
                return new { enabled = false };
            }

            CancelLocked();
            var generation = ++_generation;
            IDictationEngine engine;
            try
            {
                engine = engineFactory(new DictationEngineRequest(pushAudio, sampleRate));
            }
            catch (DictationUnavailableException err)
            {
                NotifyStartFailure(err.Message);
                return new { enabled = false, reason = err.Message };
            }
            engine.Partial += text => IfCurrent(generation, () =>
                notify("dictation.partial", new { text }));
            engine.Failed += message =>
            {
                ReleaseIfCurrent(generation, engine, () =>
                    notify("dictation.error",
                        new { message, onDevice = true, willRetryServer = false }));
                _ = Task.Run(engine.Dispose);
            };
            engine.Finalized += text =>
            {
                ReleaseIfCurrent(generation, engine, () =>
                    notify("dictation.finalized", new { text }));
                _ = Task.Run(engine.Dispose);
            };
            _engine = engine;
            try
            {
                engine.Start();
            }
            catch (Exception err)
            {
                if (ReferenceEquals(_engine, engine))
                {
                    _engine = null;
                    engine.Dispose();
                }
                NotifyStartFailure(err.Message);
                return new { enabled = false, reason = err.Message };
            }
            if (!ReferenceEquals(_engine, engine))
            {
                return new { enabled = false, reason = "recognition failed" };
            }
            return new { enabled = true, tap = engine.Tap };
        }
    }

    public object AppendAudio(string base64)
    {
        byte[] pcm;
        try
        {
            pcm = Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            return new { ok = false };
        }
        lock (_gate)
        {
            // Chunks straddling session teardown are best-effort, like macOS.
            _engine?.Append(pcm);
        }
        return new { ok = true };
    }

    public object Transcribe(string base64, int sampleRate, string requestId)
    {
        byte[] pcm;
        try
        {
            pcm = Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            return new { ok = false, reason = "invalid audio" };
        }
        if (pcm.Length == 0)
        {
            return new { ok = false, reason = "empty audio" };
        }
        if (string.IsNullOrEmpty(requestId))
        {
            return new { ok = false, reason = "missing request id" };
        }

        lock (_gate)
        {
            CancelTranscriptionLocked();
            var generation = ++_transcriptionGeneration;
            IDictationEngine engine;
            try
            {
                engine = engineFactory(new DictationEngineRequest(true, sampleRate));
            }
            catch (DictationUnavailableException err)
            {
                return new { ok = false, reason = err.Message };
            }

            engine.Failed += _ => ReleaseTranscriptionIfCurrent(
                generation,
                engine,
                () => notify("dictation.transcribed", new { requestId, text = "" }));
            engine.Finalized += text => ReleaseTranscriptionIfCurrent(
                generation,
                engine,
                () => notify("dictation.transcribed", new { requestId, text }));
            _transcriptionEngine = engine;
            try
            {
                engine.Start();
                engine.Append(pcm);
                engine.Finish(TranscriptionCompletionTimeout(pcm.Length, sampleRate));
            }
            catch (Exception err)
            {
                if (ReferenceEquals(_transcriptionEngine, engine))
                {
                    _transcriptionGeneration++;
                    _transcriptionEngine = null;
                    engine.Dispose();
                }
                return new { ok = false, reason = err.Message };
            }
            return new { ok = true };
        }
    }

    private void CancelLocked()
    {
        _generation++;
        _engine?.Cancel();
        _engine?.Dispose();
        _engine = null;
    }

    private void CancelTranscriptionLocked()
    {
        _transcriptionGeneration++;
        _transcriptionEngine?.Cancel();
        _transcriptionEngine?.Dispose();
        _transcriptionEngine = null;
    }

    private void NotifyStartFailure(string message) =>
        notify("dictation.error",
            new { message, onDevice = true, willRetryServer = false });

    private static TimeSpan TranscriptionCompletionTimeout(
        int pcmByteLength,
        int sampleRate)
    {
        var bytesPerSecond = Math.Max(sampleRate, 1) * (double)sizeof(short);
        return TimeSpan.FromSeconds(
            pcmByteLength / bytesPerSecond) +
            TranscriptionCompletionGrace;
    }

    private void IfCurrent(int generation, Action action)
    {
        lock (_gate)
        {
            if (generation != _generation)
            {
                return;
            }
            action();
        }
    }

    private void ReleaseIfCurrent(
        int generation,
        IDictationEngine engine,
        Action action)
    {
        lock (_gate)
        {
            if (generation != _generation)
            {
                return;
            }
            if (ReferenceEquals(_engine, engine))
            {
                _engine = null;
            }
            action();
        }
    }

    private void ReleaseTranscriptionIfCurrent(
        int generation,
        IDictationEngine engine,
        Action action)
    {
        lock (_gate)
        {
            if (generation != _transcriptionGeneration)
            {
                return;
            }
            if (ReferenceEquals(_transcriptionEngine, engine))
            {
                _transcriptionEngine = null;
            }
            action();
            _ = Task.Run(engine.Dispose);
        }
    }
}

/// <summary>
/// System.Speech (fully on-device) recognition over pushed PCM or the
/// system default input device.
/// </summary>
internal sealed class SystemSpeechEngine : IDictationEngine
{
    private readonly SpeechRecognitionEngine _engine;
    private readonly BlockingPcmStream? _pushStream;
    private readonly object _gate = new();
    private string _committed = "";
    private bool _finishing;
    private bool _completed;

    public SystemSpeechEngine(DictationEngineRequest request)
    {
        var installed = SpeechRecognitionEngine.InstalledRecognizers();
        var recognizer =
            installed.FirstOrDefault(info =>
                info.Culture.TwoLetterISOLanguageName ==
                CultureInfo.CurrentUICulture.TwoLetterISOLanguageName) ??
            installed.FirstOrDefault() ??
            throw new DictationUnavailableException(
                $"no speech recognizer installed for {CultureInfo.CurrentUICulture.Name}");
        try
        {
            _engine = new SpeechRecognitionEngine(recognizer);
            _engine.LoadGrammar(new DictationGrammar());
            if (request.PushAudio)
            {
                _pushStream = new BlockingPcmStream();
                _engine.SetInputToAudioStream(
                    _pushStream,
                    new SpeechAudioFormatInfo(
                        request.SampleRate, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
                Tap = $"renderer stream (pushed PCM @{request.SampleRate}Hz)";
            }
            else
            {
                // Denied or missing microphones surface here.
                _engine.SetInputToDefaultAudioDevice();
                Tap = "system default input";
            }
        }
        catch (Exception err) when (err is not DictationUnavailableException)
        {
            _pushStream?.Dispose();
            _engine?.Dispose();
            throw new DictationUnavailableException(err.Message);
        }
        _engine.SpeechHypothesized += (_, args) =>
            Partial?.Invoke(Combine(_committed, args.Result.Text));
        _engine.SpeechRecognized += (_, args) =>
        {
            lock (_gate)
            {
                _committed = Combine(_committed, args.Result.Text);
            }
            Partial?.Invoke(_committed);
        };
        _engine.RecognizeCompleted += (_, args) => Complete(args.Error?.Message);
    }

    public string Tap { get; }

    public event Action<string>? Partial;
    public event Action<string>? Finalized;
    public event Action<string>? Failed;

    public void Start() => _engine.RecognizeAsync(RecognizeMode.Multiple);

    public void Append(byte[] pcm) => _pushStream?.Push(pcm);

    public void Finish(TimeSpan completionTimeout)
    {
        lock (_gate)
        {
            _finishing = true;
        }
        _pushStream?.Complete();
        _engine.RecognizeAsyncStop();
        // Guard against a recognizer that never completes after stop.
        _ = Task.Delay(completionTimeout).ContinueWith(_ => Complete(null));
    }

    public void Cancel()
    {
        lock (_gate)
        {
            _completed = true;
        }
        _pushStream?.Complete();
        _engine.RecognizeAsyncCancel();
    }

    public void Dispose()
    {
        _pushStream?.Dispose();
        _engine.Dispose();
    }

    private void Complete(string? error)
    {
        bool finishing;
        lock (_gate)
        {
            if (_completed)
            {
                return;
            }
            _completed = true;
            finishing = _finishing;
        }
        if (error is not null && !finishing)
        {
            Failed?.Invoke(error);
            return;
        }
        Finalized?.Invoke(_committed);
    }

    private static string Combine(string committed, string next) =>
        committed.Length == 0 ? next : $"{committed} {next}";
}

/// <summary>
/// Bounded FIFO byte stream: `Read` blocks until pushed PCM arrives (or
/// the stream completes), which is what `SetInputToAudioStream` expects
/// from a live capture source.
/// </summary>
internal sealed class BlockingPcmStream : Stream
{
    private readonly Queue<byte[]> _chunks = new();
    private readonly object _gate = new();
    private byte[] _current = [];
    private int _offset;
    private bool _completed;

    public void Push(byte[] pcm)
    {
        lock (_gate)
        {
            _chunks.Enqueue(pcm);
            Monitor.PulseAll(_gate);
        }
    }

    public void Complete()
    {
        lock (_gate)
        {
            _completed = true;
            Monitor.PulseAll(_gate);
        }
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        lock (_gate)
        {
            while (_current.Length == _offset)
            {
                if (_chunks.TryDequeue(out var next))
                {
                    _current = next;
                    _offset = 0;
                    continue;
                }
                if (_completed)
                {
                    return 0;
                }
                Monitor.Wait(_gate);
            }
            var read = Math.Min(count, _current.Length - _offset);
            Array.Copy(_current, _offset, buffer, offset, read);
            _offset += read;
            return read;
        }
    }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => 0;
    public override long Position { get => 0; set => throw new NotSupportedException(); }

    public override void Flush() { }

    public override long Seek(long offset, SeekOrigin origin) =>
        throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) =>
        throw new NotSupportedException();
}

/// <summary>
/// JSON-RPC notification writer. `Console.Out` is synchronized, so each
/// serialized frame lands on stdout as one uninterleaved line alongside
/// the response frames written by the request loop.
/// </summary>
internal static class HelperNotifications
{
    public static void Emit(string method, object parameters)
    {
        Console.Out.WriteLine(JsonSerializer.Serialize(
            new { jsonrpc = "2.0", method, @params = parameters }));
        Console.Out.Flush();
    }
}
