package ai.vellum.assistant;

import com.getcapacitor.Logger;
import com.getcapacitor.PluginCall;
import java.util.function.Supplier;

final class NativeFailureGuard {
    private NativeFailureGuard() {}

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

    static void run(String logMessage, Runnable operation) {
        try {
            operation.run();
        } catch (RuntimeException exception) {
            Logger.error(logMessage, exception);
        }
    }

    static <T> T get(String logMessage, Supplier<T> operation, T fallback) {
        try {
            return operation.get();
        } catch (RuntimeException exception) {
            Logger.error(logMessage, exception);
            return fallback;
        }
    }
}
