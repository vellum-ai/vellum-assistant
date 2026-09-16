/** Restore maximized windows when clients request a title-bar drag. */
export const DESKTOP_WINDOW_DRAG_SCRIPT = String.raw`import ctypes as C
import select
import signal
import subprocess
import sys
import time


class MessageData(C.Union):
    _fields_ = [('bytes', C.c_char * 20), ('shorts', C.c_short * 10), ('longs', C.c_long * 5)]


class ClientMessage(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('sent', C.c_int),
                ('display', C.c_void_p), ('window', C.c_ulong), ('atom', C.c_ulong),
                ('format', C.c_int), ('data', MessageData)]


class Event(C.Union):
    _fields_ = [('message', ClientMessage), ('padding', C.c_long * 24)]


X = C.CDLL('libX11.so.6')
P = C.POINTER
U = C.c_ulong
I = C.c_int
D = C.c_void_p


def bind(name, result, *args):
    function = getattr(X, name)
    function.restype = result
    function.argtypes = args
    return function


open_display = bind('XOpenDisplay', D, C.c_char_p)
close_display = bind('XCloseDisplay', I, D)
root_window = bind('XDefaultRootWindow', U, D)
intern = bind('XInternAtom', U, D, C.c_char_p, I)
select_input = bind('XSelectInput', I, D, U, C.c_long)
flush = bind('XFlush', I, D)
pending = bind('XPending', I, D)
next_event = bind('XNextEvent', I, D, P(Event))
connection = bind('XConnectionNumber', I, D)
send_event = bind('XSendEvent', I, D, U, I, C.c_long, P(Event))
get_property = bind('XGetWindowProperty', I, D, U, U, C.c_long, C.c_long, I, U,
                    P(U), P(I), P(U), P(U), P(P(C.c_ubyte)))
free = bind('XFree', I, D)
get_geometry = bind('XGetGeometry', I, D, U, P(U), P(I), P(I), P(C.c_uint),
                    P(C.c_uint), P(C.c_uint), P(C.c_uint))
translate = bind('XTranslateCoordinates', I, D, U, U, I, I, P(I), P(I), P(U))
query_pointer = bind('XQueryPointer', I, D, U, P(U), P(U), P(I), P(I), P(I), P(I), P(C.c_uint))

# Windows can close between receiving a move request and reading their state.
error_handler_type = C.CFUNCTYPE(I, D, D)
error_handler = error_handler_type(lambda display, error: 0)
bind('XSetErrorHandler', D, error_handler_type)(error_handler)
display = open_display(None)
if not display:
    raise RuntimeError('Cannot connect to the desktop display')
root = root_window(display)
move_atom = intern(display, b'_NET_WM_MOVERESIZE', 0)
position_atom = intern(display, b'_NET_MOVERESIZE_WINDOW', 0)
state_atom = intern(display, b'_NET_WM_STATE', 0)
max_h = intern(display, b'_NET_WM_STATE_MAXIMIZED_HORZ', 0)
max_v = intern(display, b'_NET_WM_STATE_MAXIMIZED_VERT', 0)
notify_mask = 1 << 19
redirect_mask = 1 << 20


def maximized(window):
    actual, count, remaining = U(), U(), U()
    format = I()
    data = P(C.c_ubyte)()
    status = get_property(display, window, state_atom, 0, 64, 0, 0,
                          C.byref(actual), C.byref(format), C.byref(count),
                          C.byref(remaining), C.byref(data))
    try:
        if status or format.value != 32 or not data:
            return False
        values = C.cast(data, P(U))
        return any(values[i] in (max_h, max_v) for i in range(count.value))
    finally:
        if data:
            free(data)


def geometry(window):
    parent, child = U(), U()
    x, y = I(), I()
    width, height, border, depth = (C.c_uint() for _ in range(4))
    if not get_geometry(display, window, C.byref(parent), C.byref(x), C.byref(y),
                        C.byref(width), C.byref(height), C.byref(border), C.byref(depth)):
        return None
    if not translate(display, window, root, 0, 0, C.byref(x), C.byref(y), C.byref(child)):
        return None
    return x.value, y.value, width.value, height.value


def send(window, atom, values):
    event = Event()
    event.message.type = 33
    event.message.display = display
    event.message.window = window
    event.message.atom = atom
    event.message.format = 32
    event.message.data.longs[:] = values
    send_event(display, root, 0, notify_mask | redirect_mask, C.byref(event))
    flush(display)


def restore_drag(message):
    values = message.data.longs
    # Chrome leaves the button unspecified; source 2 marks our continuation.
    if message.format != 32 or values[2] != 8 or values[3] not in (0, 1) or values[4] == 2:
        return
    window = message.window
    if not maximized(window):
        return
    before = geometry(window)
    if not before or not before[2]:
        return
    fraction = max(0, min(1, (values[0] - before[0]) / before[2]))
    offset_y = values[1] - before[1]
    send(window, move_atom, [values[0], values[1], 11, 0, 2])
    send(window, state_atom, [0, max_h, max_v, 2, 0])
    deadline = time.monotonic() + 0.25
    while maximized(window):
        if time.monotonic() >= deadline:
            return
        time.sleep(0.005)
    after = geometry(window)
    if not after:
        return
    parent, child = U(), U()
    x, y, local_x, local_y = (I() for _ in range(4))
    buttons = C.c_uint()
    if not query_pointer(display, root, C.byref(parent), C.byref(child), C.byref(x),
                         C.byref(y), C.byref(local_x), C.byref(local_y), C.byref(buttons)):
        return
    send(window, position_atom, [(2 << 12) | (1 << 8) | (1 << 9) | 1,
                                round(x.value - fraction * after[2]), y.value - offset_y, 0, 0])
    if buttons.value & (1 << 8):
        send(window, move_atom, [x.value, y.value, 8, 1, 2])


select_input(display, root, notify_mask)
flush(display)
manager = subprocess.Popen(sys.argv[1:])
running = True


def stop(signum, frame):
    global running
    running = False


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while running and manager.poll() is None:
        if not pending(display):
            select.select([connection(display)], [], [], 0.1)
            continue
        event = Event()
        next_event(display, C.byref(event))
        if event.message.type == 33 and event.message.atom == move_atom:
            restore_drag(event.message)
finally:
    close_display(display)
    if manager.poll() is None:
        manager.terminate()
    manager.wait()
sys.exit(manager.returncode)
`;
