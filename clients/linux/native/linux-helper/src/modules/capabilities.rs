//! `capabilities.state`: what this desktop session can actually support.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;
use std::{env, fs, thread};

use serde::Serialize;
use serde_json::Value;
use zbus::blocking::{Connection, Proxy};

use crate::register_module;
use crate::rpc::error::{RpcError, RpcResult};
use crate::rpc::router::RpcModule;

/// D-Bus replies carry no deadline of their own and the RPC loop is single
/// threaded, so a wedged service must not stall every later call.
const BUS_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const PORTAL_DESTINATION: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const PORTAL_INTERFACES: [(&str, &str); 4] = [
    ("globalShortcuts", "org.freedesktop.portal.GlobalShortcuts"),
    ("notification", "org.freedesktop.portal.Notification"),
    ("remoteDesktop", "org.freedesktop.portal.RemoteDesktop"),
    ("screenCast", "org.freedesktop.portal.ScreenCast"),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BusState {
    /// Portal interface versions, `null` when the interface is missing.
    portals: BTreeMap<&'static str, Option<u32>>,
    atspi_bus: bool,
    notification_service: bool,
    /// Set when the session bus itself was unreachable, so callers can tell a
    /// missing service apart from a missing bus.
    #[serde(skip_serializing_if = "Option::is_none")]
    session_bus_error: Option<String>,
}

impl BusState {
    fn unreachable(reason: String) -> Self {
        Self {
            portals: PORTAL_INTERFACES
                .iter()
                .map(|(key, _)| (*key, None))
                .collect(),
            atspi_bus: false,
            notification_service: false,
            session_bus_error: Some(reason),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilitiesState {
    session_type: String,
    desktop: Option<String>,
    #[serde(flatten)]
    bus: BusState,
    /// Raw modifier monitoring reads the evdev nodes, which is the `input`
    /// group on most distributions.
    input_devices_readable: bool,
}

/// `wayland`, `x11`, or `unknown` when no display server announces itself.
fn session_type() -> String {
    match env::var("XDG_SESSION_TYPE") {
        Ok(value) if !value.is_empty() => value,
        _ if env::var_os("WAYLAND_DISPLAY").is_some() => "wayland".to_string(),
        _ if env::var_os("DISPLAY").is_some() => "x11".to_string(),
        _ => "unknown".to_string(),
    }
}

fn portal_version(connection: &Connection, interface: &str) -> Option<u32> {
    Proxy::new(connection, PORTAL_DESTINATION, PORTAL_PATH, interface)
        .ok()?
        .get_property::<u32>("version")
        .ok()
}

fn atspi_bus_reachable(connection: &Connection) -> bool {
    Proxy::new(connection, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus")
        .and_then(|proxy| proxy.call::<_, _, String>("GetAddress", &()))
        .is_ok()
}

fn notification_service_present(connection: &Connection) -> bool {
    Proxy::new(
        connection,
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
    )
    .and_then(|proxy| proxy.call::<_, _, bool>("NameHasOwner", &"org.freedesktop.Notifications"))
    .unwrap_or(false)
}

fn probe_bus() -> BusState {
    let connection = match Connection::session() {
        Ok(connection) => connection,
        Err(error) => return BusState::unreachable(format!("session bus unavailable: {error}")),
    };
    BusState {
        portals: PORTAL_INTERFACES
            .iter()
            .map(|(key, interface)| (*key, portal_version(&connection, interface)))
            .collect(),
        atspi_bus: atspi_bus_reachable(&connection),
        notification_service: notification_service_present(&connection),
        session_bus_error: None,
    }
}

/// A probe that outlived its deadline keeps its thread, so at most one is ever
/// in flight: repeated calls against a wedged bus must not pile threads up.
static PROBE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

fn probe_bus_with_timeout() -> BusState {
    if PROBE_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return BusState::unreachable("an earlier session bus probe is stuck".to_string());
    }
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let state = probe_bus();
        PROBE_IN_FLIGHT.store(false, Ordering::SeqCst);
        let _ = sender.send(state);
    });
    receiver
        .recv_timeout(BUS_PROBE_TIMEOUT)
        .unwrap_or_else(|_| BusState::unreachable("session bus probe timed out".to_string()))
}

fn input_devices_readable() -> bool {
    let Ok(entries) = fs::read_dir("/dev/input") else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry.file_name().to_string_lossy().starts_with("event")
            && fs::File::open(entry.path()).is_ok()
    })
}

#[derive(Default)]
pub struct CapabilitiesModule;

impl RpcModule for CapabilitiesModule {
    fn methods(&self) -> &[&'static str] {
        &["capabilities.state"]
    }

    fn call(&self, _method: &str, _params: Option<Value>) -> RpcResult {
        let state = CapabilitiesState {
            session_type: session_type(),
            desktop: env::var("XDG_CURRENT_DESKTOP").ok(),
            bus: probe_bus_with_timeout(),
            input_devices_readable: input_devices_readable(),
        };
        serde_json::to_value(state).map_err(|error| RpcError::internal(error.to_string()))
    }
}

register_module!(CapabilitiesModule);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_every_probe_even_without_a_desktop_session() {
        let state = CapabilitiesModule
            .call("capabilities.state", None)
            .expect("state");
        assert!(state["sessionType"].is_string());
        assert!(state["inputDevicesReadable"].is_boolean());
        assert!(state["atspiBus"].is_boolean());
        assert!(state["notificationService"].is_boolean());
        for (key, _) in PORTAL_INTERFACES {
            assert!(state["portals"].get(key).is_some(), "missing portal {key}");
        }
    }
}
