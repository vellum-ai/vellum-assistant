package ai.vellum.assistant;

import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeFailureReports")
public class NativeFailureReportsPlugin extends Plugin {
    private static final String EVENT_REPORT_AVAILABLE = "reportAvailable";
    private static final String FAILURE_CODE = "FAILURE_REPORTS_UNAVAILABLE";
    private static volatile NativeFailureReportsPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) {
            instance = null;
        }
    }

    @PluginMethod
    public void drain(PluginCall call) {
        NativeFailureGuard.call(
            call,
            "Unable to read Android failure reports",
            FAILURE_CODE,
            () -> {
                JSObject result = new JSObject();
                result.put("reports", NativeFailureReportStore.drain(getContext()));
                call.resolve(result);
            }
        );
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("enabled must be a boolean");
            return;
        }
        NativeFailureGuard.call(
            call,
            "Unable to update Android failure reporting",
            FAILURE_CODE,
            () -> {
                NativeFailureReportStore.setEnabled(getContext(), enabled);
                call.resolve();
            }
        );
    }

    static void notifyReportAvailable() {
        NativeFailureReportsPlugin plugin = instance;
        if (plugin == null) {
            return;
        }
        try {
            plugin.notifyListeners(EVENT_REPORT_AVAILABLE, new JSObject());
        } catch (RuntimeException exception) {
            Logger.error("Unable to announce the Android failure report", exception);
        }
    }
}
