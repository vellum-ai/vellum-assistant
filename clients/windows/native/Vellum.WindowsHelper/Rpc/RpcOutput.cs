namespace Vellum.WindowsHelper.Rpc;

public static class RpcOutput
{
    private static readonly SemaphoreSlim Gate = new(1, 1);

    public static async ValueTask WriteLineAsync(
        string frame,
        CancellationToken cancellationToken = default)
    {
        await Gate.WaitAsync(cancellationToken);
        try
        {
            await Console.Out.WriteLineAsync(frame);
            await Console.Out.FlushAsync(cancellationToken);
        }
        finally
        {
            Gate.Release();
        }
    }

    public static void WriteLine(string frame) =>
        WriteLineAsync(frame).AsTask().GetAwaiter().GetResult();
}
