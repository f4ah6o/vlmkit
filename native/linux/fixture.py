#!/usr/bin/python3
"""Local deterministic GTK3 fixtures. Never captures user applications.

`--matrix` is the accessibility semantics matrix: named/unnamed controls, an
entry, a password entry, a check button, a toggle button, radio buttons, tabs,
a combo box, a scrolled list, and identifiers on every control it can name.
Its window is 360x560, the base fixture's is 360x260; the fixed geometry is what
lets the integration runner assert semantic rectangles against known pixels.
"""
import json
import os
import sys
import gi

gi.require_version('Gtk', '3.0')
gi.require_version('Atk', '1.0')
from gi.repository import Gtk, Atk, GLib

foreign = '--foreign' in sys.argv
matrix = '--matrix' in sys.argv


def identify(widget, name, identifier):
    accessible = widget.get_accessible()
    accessible.set_name(name)
    if hasattr(accessible, 'set_accessible_id'):
        accessible.set_accessible_id(identifier)


def color_area():
    color = Gtk.DrawingArea()
    color.set_size_request(100, 60)
    identify(color, 'Fixture color', 'fixture.color')
    color.get_accessible().set_role(Atk.Role.IMAGE)
    def draw(_widget, cr):
        cr.set_source_rgb(0, 1, 0) if foreign else cr.set_source_rgb(1, 0, 0)
        cr.paint()
        return False
    color.connect('draw', draw)
    return color


def base_window(title, x, y):
    """The admitted base fixture: image, named button, entry, disabled, unnamed."""
    win = Gtk.Window(title=title)
    win.set_decorated(False)
    win.set_resizable(False)
    win.set_default_size(360, 260)
    win.move(x, y)
    win.connect('destroy', Gtk.main_quit)
    fixed = Gtk.Fixed()
    win.add(fixed)
    fixed.put(color_area(), 20, 20)
    save = Gtk.Button(label='Save')
    identify(save, 'Save', 'fixture.save')
    save.set_size_request(100, 40)
    fixed.put(save, 20, 100)
    entry = Gtk.Entry()
    identify(entry, 'Name', 'fixture.name')
    # Without this GTK3 announces a GtkEntry labelled only by its accessible name
    # as role TEXT (measured on the hosted lane); naming its ATK role keeps the
    # control an entry, which is what this profile is about.
    entry.get_accessible().set_role(Atk.Role.ENTRY)
    entry.set_text('Fixture value')
    entry.set_size_request(180, 35)
    fixed.put(entry, 140, 100)
    disabled = Gtk.Button(label='Disabled')
    identify(disabled, 'Disabled', 'fixture.disabled')
    disabled.set_sensitive(False)
    fixed.put(disabled, 20, 170)
    unnamed = Gtk.Button()
    unnamed.set_size_request(70, 35)
    fixed.put(unnamed, 160, 170)
    # A deterministic numeric value: the live lane asserts it survives AT-SPI as
    # the slider's position, not as an interface pointer.
    level = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 10, 1)
    identify(level, 'Level', 'fixture.level')
    level.set_value(4)
    level.set_size_request(320, 35)
    # GTK allocates a horizontal scale taller than its request (48px here), so
    # place it where the whole rect stays inside the 360x260 client.
    fixed.put(level, 20, 205)
    win.show_all()
    return win


def matrix_window(title, x, y):
    """Controls whose AT-SPI roles/states/values the semantic matrix asserts."""
    win = Gtk.Window(title=title)
    win.set_decorated(False)
    win.set_resizable(False)
    win.set_default_size(360, 560)
    win.move(x, y)
    win.connect('destroy', Gtk.main_quit)
    fixed = Gtk.Fixed()
    win.add(fixed)
    fixed.put(color_area(), 20, 20)

    save = Gtk.Button(label='Save')
    identify(save, 'Save', 'fixture.save')
    save.set_size_request(100, 40)
    fixed.put(save, 20, 100)

    entry = Gtk.Entry()
    identify(entry, 'Name', 'fixture.name')
    # Without this GTK3 announces a GtkEntry labelled only by its accessible name
    # as role TEXT (measured on the hosted lane); naming its ATK role keeps the
    # control an entry, which is what this profile is about.
    entry.get_accessible().set_role(Atk.Role.ENTRY)
    entry.set_text('Fixture value')
    entry.set_size_request(180, 35)
    fixed.put(entry, 140, 100)

    password = Gtk.Entry()
    password.set_visibility(False)
    identify(password, 'Secret', 'fixture.secret')
    password.set_text('hunter2')
    password.set_size_request(180, 35)
    fixed.put(password, 140, 145)

    check = Gtk.CheckButton(label='Remember')
    identify(check, 'Remember', 'fixture.remember')
    check.set_active(True)
    check.set_size_request(180, 30)
    fixed.put(check, 20, 200)

    toggle = Gtk.ToggleButton(label='Detail')
    identify(toggle, 'Detail', 'fixture.toggle')
    toggle.set_size_request(100, 30)
    fixed.put(toggle, 20, 240)

    radio_a = Gtk.RadioButton(group=None, label='Mode A')
    identify(radio_a, 'Mode A', 'fixture.mode.a')
    radio_a.set_active(True)
    radio_a.set_size_request(100, 30)
    fixed.put(radio_a, 20, 280)
    radio_b = Gtk.RadioButton(group=radio_a, label='Mode B')
    identify(radio_b, 'Mode B', 'fixture.mode.b')
    radio_b.set_size_request(100, 30)
    fixed.put(radio_b, 140, 280)

    # One accessible name per string, so a name the tree reports identifies one
    # control: the pages are "First page"/"Second page", the tabs "One"/"Two".
    # The notebook's accessible is its tab list; it keeps its own name and id as
    # long as the tab labels are named but not identified (a tab identifier can
    # replace the notebook's).
    notebook = Gtk.Notebook()
    identify(notebook, 'Pages', 'fixture.pages')
    notebook.set_tab_pos(Gtk.PositionType.TOP)
    notebook.set_size_request(320, 120)
    for label, text in (('One', 'First page'), ('Two', 'Second page')):
        page = Gtk.Label(label=text)
        identify(page, text, 'fixture.page.' + label.lower())
        tab = Gtk.Label(label=label)
        tab.get_accessible().set_name(label)
        notebook.append_page(page, tab)
    fixed.put(notebook, 20, 330)

    combo = Gtk.ComboBoxText()
    identify(combo, 'Choice', 'fixture.choice')
    for value in ('Alpha', 'Beta'):
        combo.append_text(value)
    combo.set_active(0)
    combo.set_size_request(140, 30)
    fixed.put(combo, 200, 200)
    # An open popup is its own top-level window and would make two same-PID
    # surfaces; this profile is about one window's semantics.
    if hasattr(combo, 'get_popup'):
        combo.get_popup().unmap()

    scrolling = Gtk.ScrolledWindow()
    scrolling.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
    scrolling.set_size_request(160, 60)
    store = Gtk.ListStore(str)
    for text in ('Row 0', 'Row 1', 'Row 2'):
        store.append([text])
    tree = Gtk.TreeView(model=store)
    tree.set_headers_visible(False)
    scrolling.add(tree)
    fixed.put(scrolling, 200, 240)

    disabled = Gtk.Button(label='Disabled')
    identify(disabled, 'Disabled', 'fixture.disabled')
    disabled.set_sensitive(False)
    disabled.set_size_request(100, 40)
    fixed.put(disabled, 20, 470)

    unnamed = Gtk.Button()
    unnamed.set_size_request(70, 35)
    fixed.put(unnamed, 160, 470)

    win.show_all()
    return win


def build_windows():
    """Build the fixture's windows but do not enter the main loop.

    Keeping the loop out of import is what lets `test_fixture.py` import this
    module in a child process and check that every fixture still builds: the
    previous form ran `Gtk.main()` on import, so that smoke test could only time
    out (and the live lane was the only place a renamed control surfaced).
    """
    if matrix:
        return [matrix_window('VLMKit Linux matrix', 80, 80)]
    built = [base_window('VLMKit Linux fixture', 80, 80)]
    if '--two' in sys.argv:
        built.append(base_window('VLMKit Linux fixture', 550, 80))
    return built


windows = build_windows()


def ready():
    print(json.dumps(dict(pid=os.getpid(), ready=True, foreign=foreign, matrix=matrix)), flush=True)
    return False


def run():
    GLib.timeout_add(350, ready)
    Gtk.main()


if __name__ == '__main__':
    run()
