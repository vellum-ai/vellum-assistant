package ai.vellum.assistant;

import com.getcapacitor.PluginCall;

final class PushRegistrationGuard {
    static final String FAILURE_MESSAGE = "Android push notifications are unavailable";
    private static final String FAILURE_CODE = "PUSH_REGISTRATION_FAILED";

    private PushRegistrationGuard() {}

    static void call(PluginCall call, Runnable operation) {
        NativeFailureGuard.call(call, FAILURE_MESSAGE, FAILURE_CODE, operation);
    }

    static void reject(PluginCall call) {
        call.reject(FAILURE_MESSAGE, FAILURE_CODE);
    }
}
