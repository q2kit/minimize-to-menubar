// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

// Dock, Alt+Tab, overview and workspace thumbnails all filter windows on
// these, so reporting hidden windows as skip-taskbar removes them everywhere.
const SKIP_TASKBAR_PROPS = ['skip_taskbar', 'skipTaskbar'];

const KEYBINDINGS = [
    'minimize-to-menubar-hide',
    'minimize-to-menubar-restore',
    'minimize-to-menubar-restore-all',
];

// Tray icons from the AppIndicator extension sit next to ours; follow its
// compact mode so all of them get the same padding.
const APPINDICATOR_SCHEMA = 'org.gnome.shell.extensions.appindicator';

// System shortcuts that may already use our accelerators (e.g. Super+H is
// minimize by default); we take those over while enabled.
const SYSTEM_KEYBINDING_SCHEMAS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.mutter.keybindings',
];

// '<Shift><Super>H' and '<Super><Shift>h' are the same shortcut.
function normalizeAccel(accel) {
    const mods = (accel.match(/<[^>]+>/g) ?? []).map(m => m.toLowerCase()).sort();
    return mods.join('') + accel.replace(/<[^>]+>/g, '').toLowerCase();
}

const AppIndicator = GObject.registerClass(
class AppIndicator extends PanelMenu.Button {
    _init(name, gicon, onActivate) {
        super._init(0.5, name);

        this._name = name;
        this._onActivate = onActivate;
        this._windows = [];

        // The theme drops the icon's own padding inside this box, giving the
        // same round highlight as other tray icons.
        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        const icon = new St.Icon({style_class: 'system-status-icon'});
        if (gicon)
            icon.gicon = gicon;
        else
            icon.icon_name = 'application-x-executable-symbolic';
        box.add_child(icon);
        this.add_child(box);
        this._icon = icon;

        // Clicks (and keyboard activation) end up in menu.toggle(); with a
        // single hidden window there is nothing to choose, so restore it.
        const toggle = this.menu.toggle.bind(this.menu);
        this.menu.toggle = () => {
            if (this._windows.length === 1 && !this.menu.isOpen)
                this._activateLater([...this._windows]);
            else
                toggle();
        };
    }

    // Same styles AppIndicator applies in compact mode.
    setCompact(compact) {
        this.set_style(compact ? '-natural-hpadding: 10px' : null);
        this._icon.set_style(compact ? 'margin: 0' : null);
    }

    get isEmpty() {
        return this._windows.length === 0;
    }

    addWindow(win) {
        this._windows.push(win);
        this.rebuild();
    }

    removeWindow(win) {
        this._windows = this._windows.filter(w => w !== win);
        this.rebuild();
    }

    rebuild() {
        this.menu.removeAll();

        for (const win of this._windows) {
            const item = new PopupMenu.PopupMenuItem(win.get_title() || this._name);
            item.connect('activate', () => this._activateLater([win]));
            this.menu.addMenuItem(item);
        }

        if (this._windows.length > 1) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this.menu.addAction('Show All', () => this._activateLater([...this._windows]));
        }
    }

    // Restoring rebuilds or destroys this menu, which must not happen while
    // the activated item is still handling its own signal.
    _activateLater(windows) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            windows.forEach(win => this._onActivate(win));
            return GLib.SOURCE_REMOVE;
        });
    }
});

export default class MinimizeToMenuBarExtension extends Extension {
    enable() {
        // Meta.Window -> {key, app, signalIds}
        this._hidden = new Map();
        // app key -> AppIndicator
        this._indicators = new Map();

        this._patch();

        this._settings = this.getSettings();
        this._releaseConflictingShortcuts();
        this._settings.connectObject(
            'changed::minimize-to-menubar-hide', () => this._releaseConflictingShortcuts(),
            'changed::minimize-to-menubar-restore', () => this._releaseConflictingShortcuts(),
            'changed::minimize-to-menubar-restore-all', () => this._releaseConflictingShortcuts(),
            this);

        Main.wm.addKeybinding('minimize-to-menubar-hide', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._hideFocusedWindow());
        Main.wm.addKeybinding('minimize-to-menubar-restore', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._restoreLatestWindow());
        Main.wm.addKeybinding('minimize-to-menubar-restore-all', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._restoreAllWindows());

        // Extension indicators stay in the panel on the lock screen, so hide
        // them there to avoid leaking window titles.
        Main.sessionMode.connectObject('updated',
            () => this._syncIndicatorVisibility(), this);

        const traySchema = Gio.SettingsSchemaSource.get_default()
            ?.lookup(APPINDICATOR_SCHEMA, true);
        this._traySettings = traySchema
            ? new Gio.Settings({settings_schema: traySchema}) : null;
        this._traySettings?.connectObject('changed::compact-mode-enabled',
            () => this._syncIndicatorStyle(), this);

        // Other extensions (e.g. AppIndicator) insert at fixed indices and
        // would land between our indicators, so pull ours back to the front.
        Main.panel._rightBox.connectObject('child-added',
            () => this._sortIndicators(), this);
    }

    disable() {
        Main.panel._rightBox.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._traySettings?.disconnectObject(this);
        this._traySettings = null;
        KEYBINDINGS.forEach(name => Main.wm.removeKeybinding(name));
        this._settings.disconnectObject(this);
        this._giveBackShortcuts();
        this._settings = null;

        // Leave the windows minimized; once unpatched they show up in the
        // dock and Alt+Tab again like any other minimized window.
        for (const win of [...this._hidden.keys()])
            this._forget(win);

        this._unpatch();

        this._hidden = null;
        this._indicators = null;
    }

    _patch() {
        const hidden = this._hidden;
        const proto = Meta.Window.prototype;

        // prototype -> Map(property name -> original descriptor)
        this._savedProps = new Map();
        this._patchSkipTaskbar(proto);

        this._injections = new InjectionManager();
        this._injections.overrideMethod(proto, 'is_skip_taskbar', original => {
            return function () {
                return hidden.has(this) || original.call(this);
            };
        });

        // Drop apps whose windows are all hidden, so unpinned apps leave the
        // dock and the Alt+Tab app switcher.
        this._injections.overrideMethod(Shell.AppSystem.prototype, 'get_running', original => {
            return function () {
                return original.call(this).filter(app => {
                    const windows = app.get_windows();
                    return windows.length === 0 || windows.some(w => !hidden.has(w));
                });
            };
        });
    }

    _unpatch() {
        this._injections.clear();
        this._injections = null;

        for (const [proto, descs] of this._savedProps) {
            for (const [name, desc] of descs)
                Object.defineProperty(proto, name, desc);
        }
        this._savedProps = null;
    }

    _patchSkipTaskbar(proto) {
        const hidden = this._hidden;
        const saved = this._savedProps.get(proto) ?? new Map();
        this._savedProps.set(proto, saved);

        for (const name of SKIP_TASKBAR_PROPS) {
            const desc = Object.getOwnPropertyDescriptor(proto, name);
            if (!desc?.get || saved.has(name))
                continue;
            saved.set(name, desc);
            Object.defineProperty(proto, name, {
                ...desc,
                get() {
                    return hidden.has(this) || desc.get.call(this);
                },
            });
        }
    }

    // Real windows are instances of private subclasses (MetaWindowWayland,
    // MetaWindowX11). GJS gives each its own prototype and defines property
    // accessors there, shadowing the ones on Meta.Window.prototype, so the
    // whole chain of the actual window has to be patched.
    _patchWindowPrototypes(win) {
        // Make sure the accessors are resolved before looking for them.
        SKIP_TASKBAR_PROPS.forEach(name => win[name]);

        for (let proto = Object.getPrototypeOf(win);
            proto && proto !== Meta.Window.prototype;
            proto = Object.getPrototypeOf(proto))
            this._patchSkipTaskbar(proto);
    }

    // Remove our accelerators from system shortcuts. What we take is recorded
    // in settings rather than memory, so it can still be given back after a
    // session that ended without disable() being called.
    _releaseConflictingShortcuts() {
        const ours = new Set(KEYBINDINGS
            .flatMap(name => this._settings.get_strv(name))
            .map(normalizeAccel));
        const released = JSON.parse(this._settings.get_string('released-shortcuts'));

        for (const schema of SYSTEM_KEYBINDING_SCHEMAS) {
            const settings = new Gio.Settings({schema_id: schema});
            for (const key of settings.settings_schema.list_keys()) {
                if (settings.get_value(key).get_type_string() !== 'as')
                    continue;

                const accels = settings.get_strv(key);
                const taken = accels.filter(a => ours.has(normalizeAccel(a)));
                if (taken.length === 0)
                    continue;

                settings.set_strv(key, accels.filter(a => !taken.includes(a)));
                const entry = released.find(e => e.schema === schema && e.key === key);
                if (entry)
                    entry.accels.push(...taken.filter(a => !entry.accels.includes(a)));
                else
                    released.push({schema, key, accels: taken});
            }
        }

        this._settings.set_string('released-shortcuts', JSON.stringify(released));
    }

    _giveBackShortcuts() {
        const released = JSON.parse(this._settings.get_string('released-shortcuts'));
        for (const {schema, key, accels} of released) {
            const settings = new Gio.Settings({schema_id: schema});
            const current = settings.get_strv(key);
            settings.set_strv(key, [...current, ...accels.filter(a => !current.includes(a))]);
        }
        this._settings.reset('released-shortcuts');
    }

    _restoreLatestWindow() {
        // Map keeps insertion order, so the last key is the latest hidden.
        const latest = [...this._hidden.keys()].at(-1);
        if (latest)
            this._restore(latest);
    }

    // Oldest first, so the most recently hidden window ends up on top.
    _restoreAllWindows() {
        for (const win of [...this._hidden.keys()])
            this._restore(win);
    }

    _hideFocusedWindow() {
        const focused = global.display.focus_window;
        if (!focused)
            return;

        const win = focused.find_root_ancestor();
        if (this._hidden.has(win) || win.skip_taskbar || !win.can_minimize())
            return;

        const app = Shell.WindowTracker.get_default().get_window_app(win);
        const key = app?.get_id() ?? `wm-class:${win.get_wm_class()}`;

        this._patchWindowPrototypes(win);
        win.minimize();

        const signalIds = [
            win.connect('notify::minimized', () => {
                // Something else (e.g. a notification) brought it back.
                if (!win.minimized)
                    this._forget(win);
            }),
            win.connect('unmanaged', () => this._forget(win)),
            win.connect('notify::title', () => this._indicators.get(key)?.rebuild()),
        ];
        this._hidden.set(win, {key, app, signalIds});

        let indicator = this._indicators.get(key);
        if (!indicator) {
            const name = app?.get_name() ?? win.get_wm_class() ?? 'Hidden Windows';
            indicator = new AppIndicator(name, app?.get_icon() ?? null,
                w => this._restore(w));
            Main.panel.addToStatusArea(`${this.uuid}:${key}`, indicator, 0, 'right');
            this._indicators.set(key, indicator);
            this._sortIndicators();
            this._syncIndicatorStyle();
            this._syncIndicatorVisibility();
        }
        indicator.addWindow(win);

        this._notifyChanged(win, app);
    }

    _restore(win) {
        // May run from an idle after the extension was disabled.
        if (!this._hidden?.has(win))
            return;

        this._forget(win);
        win.unminimize();
        Main.activateWindow(win);
    }

    _forget(win) {
        const entry = this._hidden.get(win);
        if (!entry)
            return;

        entry.signalIds.forEach(id => win.disconnect(id));
        this._hidden.delete(win);

        const indicator = this._indicators.get(entry.key);
        indicator.removeWindow(win);
        if (indicator.isEmpty) {
            indicator.destroy();
            this._indicators.delete(entry.key);
        }

        this._notifyChanged(win, entry.app);
    }

    _notifyChanged(win, app) {
        // Never emit notify::skip-taskbar here: ShellApp handles it in C by
        // re-reading the real flag and bumping its interesting-window count,
        // which then never drops to zero, leaving the app RUNNING without a
        // running state and crashing gnome-shell in shell_app_compare().
        // Not needed anyway: the overview rebuilds its clones when opened.
        if (app) {
            // The dock recounts an icon's windows on windows-changed and
            // rebuilds its app list on app-state-changed.
            app.emit('windows-changed');
            Shell.AppSystem.get_default().emit('app-state-changed', app);
        }
    }

    // Keep our indicators leftmost in the right box, in the order they were
    // created (Map insertion order), so newer ones sit to the right.
    _sortIndicators() {
        const box = Main.panel._rightBox;
        let index = 0;
        for (const indicator of this._indicators.values()) {
            if (indicator.container.get_parent() === box)
                box.set_child_at_index(indicator.container, index++);
        }
    }

    _syncIndicatorStyle() {
        const compact = this._traySettings?.get_boolean('compact-mode-enabled') ?? false;
        for (const indicator of this._indicators.values())
            indicator.setCompact(compact);
    }

    _syncIndicatorVisibility() {
        const visible = !Main.sessionMode.isLocked;
        for (const indicator of this._indicators.values())
            indicator.container.visible = visible;
    }
}
