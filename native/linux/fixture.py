#!/usr/bin/python3
"""Local deterministic GTK3 fixture, never captures user applications."""
import json
import os
import sys
import gi

gi.require_version('Gtk', '3.0')
gi.require_version('Atk', '1.0')
from gi.repository import Gtk, Atk, GLib

foreign = '--foreign' in sys.argv
windows = []


def identify(widget, name, identifier):
    accessible = widget.get_accessible()
    accessible.set_name(name)
    if hasattr(accessible, 'set_accessible_id'):
        accessible.set_accessible_id(identifier)


def window(title, x, y):
    win = Gtk.Window(title=title)
    win.set_decorated(False)
    win.set_resizable(False)
    win.set_default_size(360, 260)
    win.move(x, y)
    win.connect('destroy', Gtk.main_quit)
    fixed = Gtk.Fixed()
    win.add(fixed)
    color = Gtk.DrawingArea()
    color.set_size_request(100, 60)
    identify(color, 'Fixture color', 'fixture.color')
    color.get_accessible().set_role(Atk.Role.IMAGE)
    def draw(_widget, cr):
        cr.set_source_rgb(0, 1, 0) if foreign else cr.set_source_rgb(1, 0, 0)
        cr.paint()
        return False
    color.connect('draw', draw)
    fixed.put(color, 20, 20)
    save = Gtk.Button(label='Save')
    identify(save, 'Save', 'fixture.save')
    save.set_size_request(100, 40)
    fixed.put(save, 20, 100)
    entry = Gtk.Entry()
    identify(entry, 'Name', 'fixture.name')
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
    win.show_all()
    windows.append(win)


window('VLMKit Linux fixture', 80, 80)
if '--two' in sys.argv:
    window('VLMKit Linux fixture', 550, 80)


def ready():
    print(json.dumps(dict(pid=os.getpid(), ready=True, foreign=foreign)), flush=True)
    return False


GLib.timeout_add(350, ready)
Gtk.main()
