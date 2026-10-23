# Minimize to Menu Bar

A GNOME Shell extension that hides the focused window with a keyboard shortcut
and parks it behind an app icon in the top bar instead of the dock.

- Press **Super+H** to hide the focused window. It disappears from the screen,
  the dock, Alt+Tab and the Activities overview.
- An icon for that app appears in the top bar, one icon per app.
- Click the icon to restore the window. If the app has several hidden windows,
  a menu lists them by title, with a **Show All** entry.
- Press **Super+Shift+H** to restore the most recently hidden window, like
  popping a stack.
- The icon goes away when the app has no more hidden windows.

Restored windows come back exactly as they were: same position, size and
workspace, and they get focus.

## Requirements

- GNOME Shell **50** (Ubuntu 26.04). Wayland and X11 apps (via Xwayland) both
  work.
- Developed against Ubuntu Dock (`ubuntu-dock@ubuntu.com`). Upstream Dash to
  Dock uses the same window filtering and should behave the same, but has not
  been tested.

## Installation

### From a release zip

```sh
gnome-extensions install --force minimize-to-menubar@local.shell-extension.zip
```

Then **log out and back in**. On Wayland, GNOME Shell only picks up new
extensions at login. Then enable it:

```sh
gnome-extensions enable minimize-to-menubar@local
```

### From source

```sh
git clone https://github.com/q2kit/minimize-to-menubar.git
cd minimize-to-menubar
make install     # compiles the schema and symlinks into ~/.local/share/gnome-shell/extensions
```

Log out and back in, then run `gnome-extensions enable minimize-to-menubar@local`.

Because the install is a symlink, later `git pull`s only need another
log out/in to take effect.

### Building the zip

```sh
make pack        # writes dist/minimize-to-menubar@local.shell-extension.zip
```

### Uninstalling

```sh
make uninstall
```

Disable the extension **before** removing it (`make uninstall` does that for
you), so that the shortcuts it took over are given back (see below).

## Behaviour details

### Dock

| App state | Result while all its windows are hidden |
|---|---|
| Pinned to the dock | The icon stays, but loses its "running" dots and window previews |
| Not pinned | The icon is removed from the dock |

If the app still has visible windows, only the hidden ones disappear from its
dot count and previews.

### Shortcuts and the system Super+H

By default GNOME uses **Super+H** to minimize windows. While the extension is
enabled, it removes any of its own accelerators from the system shortcuts in
`org.gnome.desktop.wm.keybindings`, `org.gnome.shell.keybindings` and
`org.gnome.mutter.keybindings`. When the extension is disabled, it gives them
back.

What it took is stored in the extension's own settings (`released-shortcuts`),
not in memory. That way it can still be given back after a session that ended
without the extension being disabled cleanly, for example a crash or a
forced logout.

Change the shortcuts with `gsettings`:

```sh
SCHEMA_DIR=~/.local/share/gnome-shell/extensions/minimize-to-menubar@local/schemas
gsettings --schemadir $SCHEMA_DIR set org.gnome.shell.extensions.minimize-to-menubar \
    minimize-to-menubar-hide "['<Ctrl><Alt>h']"
gsettings --schemadir $SCHEMA_DIR set org.gnome.shell.extensions.minimize-to-menubar \
    minimize-to-menubar-restore "['<Ctrl><Alt><Shift>h']"
```

| Key | Default | Action |
|---|---|---|
| `minimize-to-menubar-hide` | `['<Super>h']` | Hide the focused window |
| `minimize-to-menubar-restore` | `['<Super><Shift>h']` | Restore the most recently hidden window |

### Other behaviour

- **Dialogs**: hiding a dialog hides its whole parent window, together with the
  dialog.
- **Windows that come back on their own**: if a hidden window gets unminimized
  some other way, for example by clicking one of the app's notifications, it
  is dropped from the menu.
- **Closed windows**: windows closed while hidden are removed from the menu.
- **Lock screen**: hidden windows stay hidden across lock and unlock. The top
  bar icons are hidden while the screen is locked, so window titles don't
  show on the lock screen.
- **Disabling the extension**: hidden windows turn into ordinary minimized
  windows and show up in the dock and Alt+Tab again. Nothing is lost.

## How it works

GNOME Shell on Wayland gives no outside program control over other apps'
windows. Tools like `xdotool` or `wmctrl` cannot do this, so the feature has to
live inside the shell as an extension.

- **Hiding** minimizes the window, then makes it report itself as
  *skip-taskbar* to the JavaScript side of the shell. The dock, Alt+Tab, the
  overview and workspace thumbnails all filter windows on `skip_taskbar`, so
  this removes the window from all of them at once.
  - The getter is patched on the window's **actual** prototype chain. Real
    windows are instances of private subclasses (`MetaWindowWayland`,
    `MetaWindowX11`), and GJS defines property accessors on each subclass's
    own prototype. Those accessors shadow anything patched on
    `Meta.Window.prototype`.
  - `Meta.Window.is_skip_taskbar()` is overridden as well.
- **Removing unpinned apps from the dock** is done by overriding
  `Shell.AppSystem.get_running()` to leave out apps whose windows are all
  hidden.
- **Refreshing**: after hiding or restoring a window, the extension emits
  `windows-changed` on the app and `app-state-changed` on the app system, so
  the dock recounts dots and rebuilds its list.

### Pitfall: never emit `notify::skip-taskbar`

It looks tempting to emit `notify::skip-taskbar` on the window so the overview
updates right away. **Don't.** `ShellApp` handles that signal in C:

- It re-reads the *real* skip-taskbar flag and adjusts its count of
  "interesting" windows.
- Every fake notification inflates that count, so it never drops back to
  zero.
- When the app's last window closes, the app stays `RUNNING` with a `NULL`
  running state.
- The next `get_running()` then crashes gnome-shell in `shell_app_compare()`.

The overview rebuilds its window clones whenever it opens, so the notification
isn't needed.

## Development

```sh
make install                   # once
# edit minimize-to-menubar@local/extension.js
# log out/in to reload
journalctl /usr/bin/gnome-shell -b -f    # watch for errors
```

To iterate without logging out, install `mutter-dev-bin` and run a nested shell
with `gnome-shell --devkit`.

If gnome-shell crashes, Ubuntu disables all user extensions
(`org.gnome.shell disable-user-extensions`). To turn them back on:

```sh
gsettings set org.gnome.shell disable-user-extensions false
```

Crash reports land in `/var/crash/_usr_bin_gnome-shell.*.crash`. Unpack one with
`apport-unpack` and open the `CoreDump` in `gdb /usr/bin/gnome-shell` to get a
native backtrace.

## Project layout

```
minimize-to-menubar@local/
├── extension.js      # all of the logic
├── metadata.json
└── schemas/          # GSettings schema (shortcuts, released-shortcuts)
Makefile              # install / uninstall / pack
```

## Known limitations

- While a window is hidden, GNOME does not show "is ready" / attention
  notifications for it.
- The dock integration relies on how Ubuntu Dock filters windows today, which
  could change in a future release.
