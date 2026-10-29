/*
 * X11-only conformance fixture for ticket 04.
 *
 * Built in the conformance image's builder stage, where a C compiler exists.
 * The runtime image copies only the resulting binary, so the Bot Screen must
 * open it through the bundle's own Xwayland.
 *
 * usage: x11-fixture [TITLE [RRGGBB]]
 *
 * Paints its background in the given color, cyan on click, and yellow on a key.
 * WebView smoke checks these real Bot Screen pixels after Takeover input.
 */
#include <X11/Xlib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned long parse_color(const char *value, unsigned long fallback) {
  if (value == NULL || strlen(value) != 6) return fallback;
  char *end = NULL;
  unsigned long parsed = strtoul(value, &end, 16);
  return end != NULL && *end == '\0' ? parsed : fallback;
}

int main(int argc, char **argv) {
  const char *title = argc > 1 ? argv[1] : "X11-ONLY-FIXTURE";
  unsigned long color = parse_color(argc > 2 ? argv[2] : NULL, 0xff00ff);

  Display *display = XOpenDisplay(NULL);
  if (display == NULL) {
    fprintf(stderr, "x11-fixture: cannot open DISPLAY\n");
    return 2;
  }
  int screen = DefaultScreen(display);
  Window window = XCreateSimpleWindow(
    display,
    RootWindow(display, screen),
    0, 0, 640, 480, 0,
    BlackPixel(display, screen),
    color);
  XStoreName(display, window, title);
  XSelectInput(display, window, ExposureMask | ButtonPressMask | KeyPressMask | StructureNotifyMask);
  Atom deleteWindow = XInternAtom(display, "WM_DELETE_WINDOW", False);
  XSetWMProtocols(display, window, &deleteWindow, 1);
  XMapWindow(display, window);
  XFlush(display);

  for (;;) {
    XEvent event;
    XNextEvent(display, &event);
    if (event.type == Expose) {
      XSetWindowBackground(display, window, color);
      XClearWindow(display, window);
      XFlush(display);
    } else if (event.type == ButtonPress || event.type == KeyPress) {
      color = event.type == KeyPress ? 0xffff00 : 0x00ffff;
      XSetWindowBackground(display, window, color);
      XClearWindow(display, window);
      XFlush(display);
    } else if (event.type == ClientMessage) {
      if ((Atom)event.xclient.data.l[0] == deleteWindow) break;
    }
  }

  XDestroyWindow(display, window);
  XCloseDisplay(display);
  return 0;
}
