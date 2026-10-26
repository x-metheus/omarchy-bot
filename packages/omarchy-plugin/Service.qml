import QtQuick
import Quickshell

Item {
  property var manifest: null
  readonly property string entryPath: decodeURIComponent(Qt.resolvedUrl("entry.sh").toString()).replace(/^file:\/\//, "")
  readonly property string installedEntryPath: (Quickshell.env("OMARCHY_BOT_HOME") || Quickshell.env("HOME") + "/.local/share/omarchy-bot") + "/runtime/plugin-entry.sh"
  readonly property string shellConfigPath: Quickshell.env("HOME") + "/.config/omarchy/shell.json"

  Component.onCompleted: Quickshell.execDetached(["bash", entryPath, "enable"])
  // shortcut: a disabled plugin leaves a poller until re-enable or the checkout disappears
  Component.onDestruction: Quickshell.execDetached(["bash", installedEntryPath, "settle", manifest.__sourceDir, shellConfigPath, manifest.id])
}
