"""Send native input only to the smoke's private Xvfb display."""
import ctypes
import os
import sys

if not os.path.exists("/.dockerenv") or not os.path.isfile("/etc/omarchy-bot-linux-app") or not os.environ.get("OMARCHY_BOT_SMOKE_DIR", "").startswith("/tmp/omarchy-bot-webkit-") or os.environ.get("DISPLAY") != ":99":
    raise RuntimeError("Native smoke input requires the private container display")
x = ctypes.CDLL("libX11.so.6")
x.XOpenDisplay.restype = ctypes.c_void_p
display = x.XOpenDisplay(None)
if not display:
    raise RuntimeError("Private Xvfb display is unavailable")
x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x.XDefaultRootWindow.restype = ctypes.c_ulong
root = x.XDefaultRootWindow(display)
if sys.argv[1] == "click":
    x.XWarpPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_int, ctypes.c_int]
    x.XWarpPointer(display, 0, root, 0, 0, 0, 0, int(sys.argv[2]), int(sys.argv[3]))
    test = ctypes.CDLL("libXtst.so.6")
    test.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    test.XTestFakeButtonEvent(display, 1, 1, 0)
    test.XTestFakeButtonEvent(display, 1, 0, 0)
elif sys.argv[1] == "close":
    parent, returned_root, count = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_uint()
    children = ctypes.POINTER(ctypes.c_ulong)()
    x.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint)]
    x.XQueryTree(display, root, ctypes.byref(returned_root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count))
    x.XFetchName.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_char_p)]
    target = None
    for window in children[:count.value]:
        name = ctypes.c_char_p()
        if x.XFetchName(display, window, ctypes.byref(name)) and name.value == b"Omarchy Bot":
            target = window
            break
    if target is None:
        raise RuntimeError("Packaged app window is missing")
    class Message(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int), ("display", ctypes.c_void_p), ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong), ("format", ctypes.c_int), ("data", ctypes.c_long * 5)]
    class Event(ctypes.Union):
        _fields_ = [("message", Message), ("padding", ctypes.c_long * 24)]
    x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x.XInternAtom.restype = ctypes.c_ulong
    event = Event()
    event.message = Message(33, 0, 1, display, target, x.XInternAtom(display, b"WM_PROTOCOLS", 0), 32, (ctypes.c_long * 5)(x.XInternAtom(display, b"WM_DELETE_WINDOW", 0), 0, 0, 0, 0))
    x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(Event)]
    x.XSendEvent(display, target, 0, 0, ctypes.byref(event))
else:
    raise RuntimeError("Expected click or close")
x.XFlush.argtypes = [ctypes.c_void_p]
x.XFlush(display)
