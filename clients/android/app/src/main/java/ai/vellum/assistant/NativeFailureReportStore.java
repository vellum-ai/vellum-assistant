package ai.vellum.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class NativeFailureReportStore {
    private static final int MAX_REPORTS = 20;
    private static final int MAX_STACK_TRACE_LENGTH = 12_000;
    private static final String ENABLED_KEY = "enabled";
    private static final String PREFERENCES = "vellum_native_failure_reports";
    private static final String REPORTS_KEY = "reports";

    private NativeFailureReportStore() {}

    static synchronized boolean isEnabled(Context context) {
        return preferences(context).getBoolean(ENABLED_KEY, false);
    }

    static synchronized void setEnabled(Context context, boolean enabled) {
        SharedPreferences.Editor editor = preferences(context)
            .edit()
            .putBoolean(ENABLED_KEY, enabled);
        if (!enabled) {
            editor.remove(REPORTS_KEY);
        }
        if (!editor.commit()) {
            throw new IllegalStateException("Unable to update Android failure reporting");
        }
    }

    static synchronized void enqueue(Context context, String message, Throwable exception) {
        SharedPreferences preferences = preferences(context);
        JSONArray reports = readReports(preferences);
        while (reports.length() >= MAX_REPORTS) {
            reports.remove(0);
        }

        JSONObject report = new JSONObject();
        try {
            report.put("message", message);
            report.put("exceptionType", exception.getClass().getName());
            report.put("stackTrace", stackTrace(exception));
            report.put("timestamp", System.currentTimeMillis());
            reports.put(report);
        } catch (JSONException jsonException) {
            throw new IllegalStateException(
                "Unable to serialize the Android failure report",
                jsonException
            );
        }

        preferences.edit().putString(REPORTS_KEY, reports.toString()).apply();
    }

    static synchronized JSONArray drain(Context context) {
        SharedPreferences preferences = preferences(context);
        JSONArray reports = readReports(preferences);
        if (!preferences.edit().remove(REPORTS_KEY).commit()) {
            throw new IllegalStateException("Unable to clear Android failure reports");
        }
        return reports;
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static JSONArray readReports(SharedPreferences preferences) {
        String serialized = preferences.getString(REPORTS_KEY, "[]");
        try {
            return new JSONArray(serialized == null ? "[]" : serialized);
        } catch (JSONException exception) {
            return new JSONArray();
        }
    }

    private static String stackTrace(Throwable exception) {
        StringBuilder trace = new StringBuilder();
        Throwable current = exception;
        int causeDepth = 0;
        while (
            current != null &&
            causeDepth < 4 &&
            trace.length() < MAX_STACK_TRACE_LENGTH
        ) {
            if (causeDepth > 0) {
                trace.append("Caused by: ");
            }
            trace.append(current.getClass().getName()).append('\n');
            for (StackTraceElement frame : current.getStackTrace()) {
                trace.append("  at ").append(frame).append('\n');
                if (trace.length() >= MAX_STACK_TRACE_LENGTH) {
                    break;
                }
            }
            current = current.getCause();
            causeDepth += 1;
        }
        if (trace.length() > MAX_STACK_TRACE_LENGTH) {
            return trace.substring(0, MAX_STACK_TRACE_LENGTH);
        }
        return trace.toString();
    }
}
