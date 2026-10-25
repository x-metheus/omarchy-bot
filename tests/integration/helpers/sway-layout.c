#define _GNU_SOURCE
#include <poll.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

/* One titled xdg toplevel, optionally followed by a transient dialog.
 * The dialog sets its parent before the first commit: sway floats and
 * centers a window from that, and never recenters one it already tiled. */

static struct wl_display *display;
static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm_base;
static bool running = true;

static void noop(void) {}

static void wm_ping(void *data, struct xdg_wm_base *base, uint32_t serial) {
  (void)data;
  xdg_wm_base_pong(base, serial);
}

static const struct xdg_wm_base_listener wm_listener = { wm_ping };

static void registry_global(void *data, struct wl_registry *registry, uint32_t name,
    const char *interface, uint32_t version) {
  (void)data;
  (void)version;
  if (strcmp(interface, wl_compositor_interface.name) == 0) {
    compositor = wl_registry_bind(registry, name, &wl_compositor_interface, 4);
  } else if (strcmp(interface, wl_shm_interface.name) == 0) {
    shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
  } else if (strcmp(interface, xdg_wm_base_interface.name) == 0) {
    wm_base = wl_registry_bind(registry, name, &xdg_wm_base_interface, 1);
    xdg_wm_base_add_listener(wm_base, &wm_listener, NULL);
  }
}

static const struct wl_registry_listener registry_listener = {
  registry_global,
  (void (*)(void *, struct wl_registry *, uint32_t))noop,
};

struct buffer {
  struct wl_buffer *buffer;
  void *data;
  int stride;
  int height;
};

static void buffer_release(void *data, struct wl_buffer *buffer) {
  (void)data;
  (void)buffer;
}

static const struct wl_buffer_listener buffer_listener = { buffer_release };

static struct buffer *create_buffer(int width, int height, uint32_t color) {
  int stride = width * 4;
  int size = stride * height;
  int fd = memfd_create("sway-layout", 0);
  if (fd < 0 || ftruncate(fd, size) < 0) return NULL;
  void *data = mmap(NULL, (size_t)size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (data == MAP_FAILED) return NULL;
  for (int index = 0; index < width * height; index += 1) ((uint32_t *)data)[index] = color;
  struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
  close(fd);
  struct buffer *buffer = calloc(1, sizeof(*buffer));
  buffer->buffer = wl_shm_pool_create_buffer(pool, 0, width, height, stride, WL_SHM_FORMAT_ARGB8888);
  wl_buffer_add_listener(buffer->buffer, &buffer_listener, NULL);
  wl_shm_pool_destroy(pool);
  buffer->data = data;
  buffer->stride = stride;
  buffer->height = height;
  return buffer;
}

struct surface_state {
  struct wl_surface *surface;
  int width;
  int height;
  int attached_width;
  int attached_height;
  uint32_t color;
  bool mapped;
};

static void toplevel_configure(void *data, struct xdg_toplevel *toplevel,
    int32_t width, int32_t height, struct wl_array *states) {
  (void)toplevel;
  (void)states;
  struct surface_state *state = data;
  /* The size this client asked for is narrower than the Screen, so it looks like a split. */
  if (width > 0) state->width = width;
  if (height > 0) state->height = height;
}

static void toplevel_close(void *data, struct xdg_toplevel *toplevel) {
  (void)data;
  (void)toplevel;
  running = false;
}

static const struct xdg_toplevel_listener toplevel_listener = {
  toplevel_configure,
  toplevel_close,
};

static void surface_configure(void *data, struct xdg_surface *surface, uint32_t serial) {
  struct surface_state *state = data;
  xdg_surface_ack_configure(surface, serial);
  if (state->attached_width == state->width && state->attached_height == state->height) {
    state->mapped = true;
    return;
  }
  struct buffer *buffer = create_buffer(state->width, state->height, state->color);
  wl_surface_attach(state->surface, buffer->buffer, 0, 0);
  wl_surface_commit(state->surface);
  state->attached_width = state->width;
  state->attached_height = state->height;
  state->mapped = true;
}

static const struct xdg_surface_listener surface_listener = { surface_configure };

static struct xdg_toplevel *map_window(const char *title, const char *app_id,
    struct xdg_toplevel *parent, int width, int height, uint32_t color) {
  struct wl_surface *surface = wl_compositor_create_surface(compositor);
  struct xdg_surface *shell_surface = xdg_wm_base_get_xdg_surface(wm_base, surface);
  struct surface_state *state = calloc(1, sizeof(*state));
  state->surface = surface;
  state->width = width;
  state->height = height;
  state->color = color;
  xdg_surface_add_listener(shell_surface, &surface_listener, state);
  struct xdg_toplevel *toplevel = xdg_surface_get_toplevel(shell_surface);
  xdg_toplevel_add_listener(toplevel, &toplevel_listener, state);
  xdg_toplevel_set_title(toplevel, title);
  xdg_toplevel_set_app_id(toplevel, app_id);
  if (parent != NULL) xdg_toplevel_set_parent(toplevel, parent);
  wl_surface_commit(surface);
  while (!state->mapped && wl_display_dispatch(display) != -1) {}
  wl_display_flush(display);
  return toplevel;
}

int main(int argc, char **argv) {
  const char *title = argc > 1 ? argv[1] : "Layout Fixture";
  const int dialog_delay_ms = argc > 2 ? atoi(argv[2]) : 0;
  const char *dialog_title = argc > 3 && argv[3][0] != '\0' ? argv[3] : "Layout Dialog";
  const char *app_id = argc > 5 && argv[5][0] != '\0' ? argv[5] : "dev.omarchy.LayoutFixture";
  /* A per-window body color makes the focused window's body identifiable in a capture. */
  const uint32_t body_color = argc > 6 ? (uint32_t)strtoul(argv[6], NULL, 0) : 0xfff2f2f2;

  display = wl_display_connect(NULL);
  if (display == NULL) return 1;
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &registry_listener, NULL);
  wl_display_roundtrip(display);
  if (compositor == NULL || shm == NULL || wm_base == NULL) return 1;

  struct xdg_toplevel *owner = map_window(title, app_id, NULL, 640, 480, body_color);
  if (dialog_delay_ms > 0) {
    poll(NULL, 0, dialog_delay_ms);
    wl_display_roundtrip(display);
    map_window(dialog_title, app_id, owner, 220, 140, 0xffffffff);
  }

  while (running && wl_display_dispatch(display) != -1) {}
  return 0;
}
