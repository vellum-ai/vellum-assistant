/** Runs inside the virtual desktop's Linux session, using the AT-SPI D-Bus API. */
export const DESKTOP_ACCESSIBILITY_SCRIPT = String.raw`
import json, os, sys, time
import dbus

ACCESSIBLE = "org.a11y.atspi.Accessible"
COMPONENT = "org.a11y.atspi.Component"
PROPERTIES = "org.freedesktop.DBus.Properties"
ROOT = "/org/a11y/atspi/accessible/root"
LIMIT = 300
DEADLINE = time.monotonic() + 2

def call(bus, ref, interface, method, *args):
    remaining = DEADLINE - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Accessibility query exceeded its time limit")
    obj = bus.get_object(str(ref[0]), str(ref[1]), introspect=False)
    return obj.get_dbus_method(method, interface)(*args, timeout=min(0.2, remaining))

def read(bus, ref, depth=0):
    name = call(bus, ref, PROPERTIES, "Get", ACCESSIBLE, "Name")
    child_count = call(bus, ref, PROPERTIES, "Get", ACCESSIBLE, "ChildCount")
    role = str(call(bus, ref, ACCESSIBLE, "GetRoleName"))
    states = call(bus, ref, ACCESSIBLE, "GetState")
    bits = sum(int(word) << (32 * i) for i, word in enumerate(states))
    showing = bool(bits & (1 << 25)) and bool(bits & (1 << 30))
    bounds = None
    if showing and not bits & (1 << 6):
        try:
            bounds = [int(n) for n in call(bus, ref, COMPONENT, "GetExtents", dbus.UInt32(0))]
        except dbus.DBusException:
            pass
    return {
        "bus": str(ref[0]), "path": str(ref[1]), "depth": depth,
        "name": str(name)[:200], "role": role[:80],
        "bounds": bounds,
        "states": [label for bit, label in [(4, "checked"), (8, "enabled"), (12, "focused"), (23, "selected")] if bits & (1 << bit)],
    }, int(child_count)

def main():
    request = json.loads(sys.argv[1])
    session = dbus.bus.BusConnection(os.environ["DBUS_SESSION_BUS_ADDRESS"])
    service = ("org.a11y.Bus", "/org/a11y/bus")
    call(session, service, PROPERTIES, "Set", "org.a11y.Status", "IsEnabled", dbus.Boolean(True, variant_level=1))
    address = str(call(session, service, "org.a11y.Bus", "GetAddress"))
    bus = dbus.bus.BusConnection(address)
    bus_id = str(call(bus, ("org.freedesktop.DBus", "/org/freedesktop/DBus"), "org.freedesktop.DBus", "GetId"))
    if request["operation"] == "resolve":
        if request["busId"] != bus_id:
            raise ValueError("Accessibility session changed. Observe again.")
        target = request["target"]
        node, _ = read(bus, (target["bus"], target["path"]))
        if node["name"] != target["name"] or node["role"] != target["role"] or not node["bounds"]:
            raise ValueError("Accessibility element changed or is hidden. Observe again.")
        print(json.dumps(node))
        return
    pending = [("org.a11y.atspi.Registry", ROOT, 0)]
    seen, nodes = set(), []
    truncated = False
    while pending and len(seen) < LIMIT and time.monotonic() < DEADLINE:
        name, path, depth = pending.pop()
        ref = (name, path)
        if ref in seen or path == "/org/a11y/atspi/null":
            continue
        seen.add(ref)
        try:
            node, count = read(bus, ref, depth)
            if node["bounds"]:
                nodes.append(node)
            if depth < 20:
                children = []
                for i in range(min(count, LIMIT - len(seen))):
                    child = call(bus, ref, ACCESSIBLE, "GetChildAtIndex", dbus.Int32(i))
                    children.append((str(child[0]) or name, str(child[1]), depth + 1))
                pending.extend(reversed(children))
                truncated = truncated or count > len(children)
            elif count:
                truncated = True
        except (dbus.DBusException, TimeoutError):
            truncated = True
    print(json.dumps({"busId": bus_id, "nodes": nodes, "truncated": truncated or bool(pending)}))

try:
    main()
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`;
