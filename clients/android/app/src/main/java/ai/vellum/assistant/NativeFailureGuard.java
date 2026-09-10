package ai.vellum.assistant;

import android.content.Context;
import com.getcapacitor.Logger;
import com.getcapacitor.PluginCall;
import java.util.function.Supplier;

public final class NativeFailureGuard {
    private static volatile Context applicationContext;

    private NativeFailureGuard() {}

    static void initialize(Context context) {
        applicationContext = context.getApplicationContext();
    }

    static void call(
        PluginCall call,
        String failureMessage,
        String failureCode,
        Runnable operation
    ) {
        try {
            operation.run();
        } catch (RuntimeException exception) {
            call.reject(failureMessage, failureCode, exception);
        }
    }

    public static void run(String logMessage, Runnable operation) {
        try {
            operation.run();
        } catch (RuntimeException exception) {
            record(logMessage, exception);
        }
    }

    public static <T> T get(String logMessage, Supplier<T> operation, T fallback) {
        try {
            return operation.get();
        } catch (RuntimeException exception) {
            record(logMessage, exception);
            return fallback;
        }
    }

    /**
     * {@link #get} widened to {@link Throwable} for work that can exhaust the
     * heap, such as decoding a bitmap: the fallback is a notification without
     * an avatar, while an escaping OutOfMemoryError loses the push entirely.
     */
    public static <T> T getAllocating(String logMessage, Supplier<T> operation, T fallback) {
        try {
            return operation.get();
        } catch (Throwable throwable) {
            record(logMessage, throwable);
            return fallback;
        }
    }

    public static void record(String logMessage, Throwable exception) {
        Logger.error(logMessage, exception);
        Context context = applicationContext;
        if (context == null) {
            return;
        }
        try {
            if (!NativeFailureReportStore.isEnabled(context)) {
                return;
            }
            NativeFailureReportStore.enqueue(context, logMessage, exception);
            NativeFailureReportsPlugin.notifyReportAvailable();
        } catch (RuntimeException storageException) {
            Logger.error("Unable to store the Android failure report", storageException);
        }
    }
}
