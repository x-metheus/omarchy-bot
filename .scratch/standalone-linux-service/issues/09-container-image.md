# 09: Container image

**What to build:** A single `docker run` with one state volume gives a working, pairing-required Service on a cloud VM with no desktop, including Bot Screens.

**Blocked by:** 02, 04, 05, 06

**Status:** ready-for-agent

Spec: [standalone Linux Service](../spec.md)

- [ ] The image runs `serve` as an unprivileged user and stores all state on one volume.
- [ ] The health route works for container health checks.
- [ ] Logs go to stdout.
- [ ] A paired client can create a Bot, run a Turn, open a Bot Screen, and `open_url` inside the container.
- [ ] Restarting the container with the same volume preserves Bots, Threads, Paired Devices, and the Bot Computer profile.
