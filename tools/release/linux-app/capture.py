import sys
import gi

gi.require_version("Gdk", "3.0")
from gi.repository import Gdk

window = Gdk.get_default_root_window()
if window is None:
    raise RuntimeError("Private Xvfb display is unavailable")
pixels = Gdk.pixbuf_get_from_window(window, 0, 0, window.get_width(), window.get_height())
if pixels is None:
    raise RuntimeError("Could not capture private Xvfb display")
pixels.savev(sys.argv[1], "png", [], [])
