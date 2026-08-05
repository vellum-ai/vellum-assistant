package ai.vellum.assistant;

import com.getcapacitor.PluginCall;

final class PushRegistrationGuard {
    private static final String FAILURE_CODE = "PUSH_REGISTRATION_FAILED";
    private static final String FAILURE_MESSAGE = "Android push notifications are unavailable";

    private PushRegistrationGuard() {}

    static void run(PluginCall call, Runnable operation) {
        try {
            operation.run();
        } catch (RuntimeException exception) {
            call.reject(FAILURE_MESSAGE, FAILURE_CODE, exception);
        }
    }

    static void reject(PluginCall call) {
        call.reject(FAILURE_MESSAGE, FAILURE_CODE);
    }
}
