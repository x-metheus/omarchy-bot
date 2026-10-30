"""Exercise packaged startup logging with a broken stderr pipe in the private smoke profile."""
import os
from pathlib import Path
import subprocess
import time

run = Path(os.environ["OMARCHY_BOT_SMOKE_DIR"])
if not Path("/.dockerenv").exists() or not str(run).startswith("/tmp/omarchy-bot-webkit-"):
    raise RuntimeError("Logging checks require the private Linux app container")
app = run / "squashfs-root/AppRun"
evidence = Path("/src/.lane/linux-app/evidence")
for scenario in ("early-panic", "startup"):
    profile = run / f"logging-{scenario}"
    profile.mkdir()
    environment = {**os.environ, "HOME": str(profile), "XDG_DATA_HOME": str(profile / "data"),
                   "XDG_CONFIG_HOME": str(profile / "config"), "XDG_CACHE_HOME": str(profile / "cache")}
    if scenario == "early-panic":
        environment.update(DISPLAY=":invalid", WAYLAND_DISPLAY="", GDK_BACKEND="x11")
    log = profile / "data/com.omarchy.bot/logs/omarchy-bot.log"
    reader, writer = os.pipe()
    os.close(reader)  # Every native stderr write fails with EPIPE from the first byte.
    process = subprocess.Popen([str(app)], env=environment, stdout=subprocess.DEVNULL, stderr=writer)
    os.close(writer)
    try:
        if scenario == "early-panic":
            status = process.wait(timeout=15)
            assert status != 0, "Unavailable display must fail native runtime creation"
            assert log.exists(), "Early runtime failure must create the documented persistent log"
            assert "panic location=" in log.read_text(), "Early GTK panic must reach persistent logging despite broken stderr"
        else:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and process.poll() is None:
                close = subprocess.run(["python3", "/src/scripts/linux-app/input.py", "close"], env=environment, capture_output=True)
                if close.returncode == 0:
                    break
                time.sleep(0.05)
            else:
                raise AssertionError("Broken stderr must not prevent the native window from opening")
            assert process.wait(timeout=5) == 0, "Window close must return zero despite broken stderr"
            assert log.exists() and " startup\n" in log.read_text(), "Startup must reach the persistent log despite broken stderr"
            assert "event-loop-return code=0" in log.read_text(), "Normal close must reach persistent logging despite broken stderr"
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        if log.exists():
            (evidence / f"logging-{scenario}.log").write_text(log.read_text())
print("PASS packaged startup and early runtime panic persist with broken stderr")
