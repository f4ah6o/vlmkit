#!/usr/bin/env python3
"""Read-only, PID-attached X11/AT-SPI observer. stdout is protocol-only.

Uses system shared libraries through ctypes; no GI typelib or pip dependencies.
X11 is a trusted local desktop protocol, not a security boundary against malicious
clients forging _NET_WM_PID. No input, focus, activation, launch or termination API.
"""
import ctypes as C
import ctypes.util
import json
import os
from pathlib import Path
import re
import struct
import sys
import time
import uuid
import zlib

P = C.c_void_p
U = C.c_ulong
I = C.c_int


class Failure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise Failure(code, message)


def bind(lib, name, result, *args):
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = result, list(args)
    return fn


def library(name):
    path = ctypes.util.find_library(name)
    if not path:
        fail('NATIVE_DEPENDENCY_MISSING', 'Missing system library: ' + name)
    return C.CDLL(path)


def bounded_int(value, default, low, high):
    if value is None:
        return default
    if type(value) is not int or not low <= value <= high:
        fail('NATIVE_INVALID_PARAMS', f'Expected integer in [{low}, {high}]')
    return value


def process_identity(pid):
    try:
        # starttime prevents PID reuse from attaching a different process.
        return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        fail('NATIVE_TARGET_EXITED', 'Target process is unavailable')


def rect(x, y, w, h):
    return dict(left=x, top=y, width=w, height=h)


ROLES = {'push button': 'button', 'toggle button': 'button', 'entry': 'textfield',
         'password text': 'textfield', 'check box': 'checkbox', 'radio button': 'radio',
         'page tab': 'tab', 'menu item': 'menuitem', 'combo box': 'combobox',
         'label': 'text', 'static': 'text', 'panel': 'group', 'list item': 'listitem',
         'scroll pane': 'scrollview', 'frame': 'window'}


def associate(accessibles, windows):
    """Only unique same-PID exact SCREEN extents are admitted; titles are ignored."""
    result = []
    for a in accessibles:
        matches = [w for w in windows if a['pid'] == w['pid'] and a['rect'] == w['rect']]
        if len(matches) != 1:
            continue
        w = matches[0]
        if sum(other['pid'] == w['pid'] and other['rect'] == w['rect'] for other in accessibles) != 1:
            continue
        result.append(dict(a, xid=w['xid']))
    return result


def choose(windows, selector=None):
    if not windows:
        fail('NATIVE_WINDOW_NOT_FOUND', 'No uniquely associated visible AT-SPI/X11 client window')
    if selector is not None:
        if not isinstance(selector, dict):
            fail('NATIVE_INVALID_PARAMS', 'Invalid selector')
        by = selector.get('by')
        if by == 'window-id':
            matches = [w for w in windows if w['windowId'] == selector.get('windowId')]
        elif by == 'index':
            index = bounded_int(selector.get('index'), -1, 0, 10000)
            matches = windows[index:index + 1] if index >= 0 else []
        elif by in ('focused', 'main'):
            matches = [w for w in windows if w[by]]
        else:
            fail('NATIVE_INVALID_PARAMS', 'Invalid selector')
    else:
        matches = [w for w in windows if w['focused']]
        if len(matches) != 1:
            matches = windows
    if len(matches) != 1:
        fail('NATIVE_WINDOW_AMBIGUOUS' if matches else 'NATIVE_WINDOW_NOT_FOUND', 'Select one window explicitly')
    return matches[0]


class GError(C.Structure):
    _fields_ = [('domain', C.c_uint), ('code', I), ('message', C.c_char_p)]


class Rect(C.Structure):
    _fields_ = [('x', I), ('y', I), ('width', I), ('height', I)]


class Atspi:
    def __init__(self):
        self.lib = library('atspi')
        self.glib = library('glib-2.0')
        self.gobj = library('gobject-2.0')
        self.free = bind(self.glib, 'g_free', None, P)
        self.unref = bind(self.gobj, 'g_object_unref', None, P)
        self.error_free = bind(self.glib, 'g_error_free', None, P)
        self.refs = []
        self.fns = {}
        if bind(self.lib, 'atspi_init', I)() != 0:
            fail('NATIVE_ACCESSIBILITY_UNAVAILABLE', 'AT-SPI initialization failed')
        bind(self.lib, 'atspi_set_timeout', None, I, I)(1000, 1000)
        self.deadline = time.monotonic() + 15

    def call(self, name, obj=None, args=(), types=(), result=P, error=True):
        if time.monotonic() > self.deadline:
            fail('NATIVE_AX_TIMEOUT', 'AT-SPI operation exceeded 15 seconds')
        full = 'atspi_' + name
        signature = ((P,) if obj is not None else ()) + tuple(types) + ((C.POINTER(P),) if error else ())
        key = (full, signature, result)
        fn = self.fns.setdefault(key, bind(self.lib, full, result, *signature))
        err = P()
        argv = ((obj,) if obj is not None else ()) + tuple(args) + ((C.byref(err),) if error else ())
        out = fn(*argv)
        if err:
            message = C.cast(err, C.POINTER(GError)).contents.message.decode('utf-8', 'replace')
            self.error_free(err)
            fail('NATIVE_AX_CANNOT_COMPLETE', message)
        return out

    def obj(self, name, obj=None, args=(), types=(), error=True):
        value = self.call(name, obj, args, types, error=error)
        if value:
            self.refs.append(value)
        return value

    def text(self, name, obj):
        ptr = self.call(name, obj)
        if not ptr:
            return ''
        try:
            return C.string_at(ptr).decode('utf-8', 'replace')
        finally:
            self.free(ptr)

    def children(self, obj):
        count = self.call('accessible_get_child_count', obj, result=I)
        if not 0 <= count <= 10000:
            fail('NATIVE_AX_TRUNCATED', 'Child count exceeds traversal limit')
        for index in range(count):
            child = self.obj('accessible_get_child_at_index', obj, (index,), (I,))
            if child:
                yield index, child

    def bounds(self, obj):
        component = self.obj('accessible_get_component_iface', obj, error=False)
        if not component:
            return None
        ptr = self.call('component_get_extents', component, (0,), (I,))  # ATSPI_COORD_TYPE_SCREEN
        if not ptr:
            return None
        try:
            r = C.cast(ptr, C.POINTER(Rect)).contents
            return rect(r.x, r.y, r.width, r.height)
        finally:
            self.free(ptr)

    def pid(self, obj):
        return self.call('accessible_get_process_id', obj, result=C.c_uint)

    def states(self, obj):
        state = self.obj('accessible_get_state_set', obj, error=False)
        if not state:
            return {}
        def has(n):
            return bool(self.call('state_set_contains', state, (n,), (I,), result=I, error=False))
        # Public AtspiStateType enum; absence is not interpreted as disabled.
        out = {}
        for name, number in [('focused', 12), ('checked', 4), ('selected', 23), ('expanded', 10)]:
            if has(number):
                out[name] = True
        if has(25) is False:  # SHOWING
            out['hidden'] = True
        if has(8) is False:  # ENABLED
            out['disabled'] = True
        return out

    def windows(self, pid):
        desktop = self.obj('get_desktop', args=(0,), types=(I,), error=False)
        if not desktop:
            fail('NATIVE_ACCESSIBILITY_UNAVAILABLE', 'AT-SPI desktop unavailable')
        found = []
        for _, app in self.children(desktop):
            if self.pid(app) != pid:
                continue
            for index, child in self.children(app):
                if self.pid(child) != pid:
                    continue
                role = self.text('accessible_get_role_name', child)
                bounds = self.bounds(child)
                if role in ('frame', 'window', 'dialog', 'alert') and bounds and bounds['width'] > 0 and bounds['height'] > 0:
                    found.append(dict(obj=child, pid=pid, rect=bounds, index=index,
                                      title=self.text('accessible_get_name', child), states=self.states(child)))
        return found

    def release(self):
        for obj in reversed(self.refs):
            self.unref(obj)
        self.refs.clear()


class XAttributes(C.Structure):
    _fields_ = [(name, typ) for name, typ in [
        ('x', I), ('y', I), ('width', I), ('height', I), ('border_width', I), ('depth', I),
        ('visual', P), ('root', U), ('class_', I), ('bit_gravity', I), ('win_gravity', I),
        ('backing_store', I), ('backing_planes', U), ('backing_pixel', U), ('save_under', I),
        ('colormap', U), ('map_installed', I), ('map_state', I), ('all_event_masks', C.c_long),
        ('your_event_mask', C.c_long), ('do_not_propagate_mask', C.c_long), ('override_redirect', I), ('screen', P)]]


class XImage(C.Structure):
    _fields_ = [('width', I), ('height', I), ('xoffset', I), ('format', I), ('data', P),
                ('byte_order', I), ('bitmap_unit', I), ('bitmap_bit_order', I), ('bitmap_pad', I),
                ('depth', I), ('bytes_per_line', I), ('bits_per_pixel', I),
                ('red_mask', U), ('green_mask', U), ('blue_mask', U)]


def png_from_ximage(im):
    """Encode only common TrueColor formats. Never guess unsupported pixel layouts."""
    if im.bits_per_pixel not in (24, 32) or im.byte_order not in (0, 1) or im.depth != 24:
        fail('NATIVE_SCREENSHOT_FAILED', 'Unsupported X11 pixel layout')
    if (im.red_mask, im.green_mask, im.blue_mask) != (0xff0000, 0xff00, 0xff):
        fail('NATIVE_SCREENSHOT_FAILED', 'Unsupported X11 color masks')
    step = im.bits_per_pixel // 8
    if im.bytes_per_line < im.width * step or im.bytes_per_line > im.width * step + 16:
        fail('NATIVE_SCREENSHOT_FAILED', 'Invalid X11 image stride')
    data = C.string_at(im.data, im.bytes_per_line * im.height)
    rows = bytearray()
    for y in range(im.height):
        rows.append(0)
        for x in range(im.width):
            at = y * im.bytes_per_line + x * step
            pixel = int.from_bytes(data[at:at + step], 'little' if im.byte_order == 0 else 'big')
            rows.extend(((pixel >> 16) & 255, (pixel >> 8) & 255, pixel & 255))
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', im.width, im.height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


class X11:
    def __init__(self):
        self.lib = library('X11')
        self.composite = library('Xcomposite')
        self.errors = []
        self.handler = C.CFUNCTYPE(I, P, P)(lambda _d, _e: self.errors.append('X11 request failed') or 0)
        bind(self.lib, 'XSetErrorHandler', P, P)(self.handler)
        self.display = bind(self.lib, 'XOpenDisplay', P, C.c_char_p)(None)
        if not self.display:
            fail('NATIVE_DISPLAY_UNAVAILABLE', 'Cannot open DISPLAY')
        self.root = self.fn('XDefaultRootWindow', U)()
        major, minor = I(), I()
        if not bind(self.composite, 'XCompositeQueryVersion', I, P, C.POINTER(I), C.POINTER(I))(self.display, C.byref(major), C.byref(minor)) or (major.value, minor.value) < (0, 2):
            fail('NATIVE_SCREENSHOT_UNAVAILABLE', 'XComposite 0.2+ required')

    def fn(self, name, result, *types):
        fn = bind(self.lib, name, result, P, *types)
        return lambda *args: fn(self.display, *args)

    def sync(self):
        self.fn('XSync', I, I)(0)
        if self.errors:
            self.errors.clear()
            fail('NATIVE_WINDOW_CHANGED', 'X11 window disappeared or request failed')

    def children(self, xid):
        root, parent, data, count = U(), U(), P(), C.c_uint()
        ok = self.fn('XQueryTree', I, U, C.POINTER(U), C.POINTER(U), C.POINTER(P), C.POINTER(C.c_uint))(xid, C.byref(root), C.byref(parent), C.byref(data), C.byref(count))
        self.sync()
        if not ok or count.value > 10000:
            fail('NATIVE_WINDOW_CHANGED', 'Cannot enumerate bounded X11 window tree')
        try:
            return list(C.cast(data, C.POINTER(U))[:count.value]) if data else []
        finally:
            if data:
                bind(self.lib, 'XFree', I, P)(data)

    def pid(self, xid):
        atom = self.fn('XInternAtom', U, C.c_char_p, I)(b'_NET_WM_PID', 1)
        if not atom:
            return None
        actual, fmt, count, after, data = U(), I(), U(), U(), P()
        status = self.fn('XGetWindowProperty', I, U, U, C.c_long, C.c_long, I, U, C.POINTER(U), C.POINTER(I), C.POINTER(U), C.POINTER(U), C.POINTER(P))(xid, atom, 0, 1, 0, 6, C.byref(actual), C.byref(fmt), C.byref(count), C.byref(after), C.byref(data))
        self.sync()
        try:
            return C.cast(data, C.POINTER(U))[0] if status == 0 and actual.value == 6 and fmt.value == 32 and count.value == 1 and after.value == 0 and data else None
        finally:
            if data:
                bind(self.lib, 'XFree', I, P)(data)

    def geometry(self, xid):
        a = XAttributes()
        ok = self.fn('XGetWindowAttributes', I, U, C.POINTER(XAttributes))(xid, C.byref(a))
        self.sync()
        if not ok or a.map_state != 2 or a.class_ != 1 or a.border_width != 0:
            return None
        x, y, child = I(), I(), U()
        ok = self.fn('XTranslateCoordinates', I, U, U, I, I, C.POINTER(I), C.POINTER(I), C.POINTER(U))(xid, self.root, 0, 0, C.byref(x), C.byref(y), C.byref(child))
        self.sync()
        if not ok or not 0 < a.width <= 8192 or not 0 < a.height <= 8192 or a.width * a.height > 16777216:
            return None
        return rect(x.value, y.value, a.width, a.height)

    def windows(self, pid):
        out, stack, count = [], [(self.root, 0)], 0
        while stack:
            xid, depth = stack.pop()
            count += 1
            if count > 10000 or depth > 32:
                fail('NATIVE_WINDOW_AMBIGUOUS', 'X11 enumeration bound exceeded')
            if xid != self.root and self.pid(xid) == pid:
                bounds = self.geometry(xid)
                if bounds:
                    out.append(dict(xid=xid, pid=pid, rect=bounds))
            stack.extend((child, depth + 1) for child in self.children(xid))
        return out

    def assert_descendants_owned(self, xid, pid):
        stack, count = [xid], 0
        while stack:
            child = stack.pop()
            count += 1
            if count > 10000:
                fail('NATIVE_WINDOW_AMBIGUOUS', 'X11 descendant bound exceeded')
            owner = self.pid(child)
            if owner is not None and owner != pid:
                fail('NATIVE_WINDOW_OWNERSHIP', 'Window embeds an explicitly foreign-PID X11 child')
            stack.extend(self.children(child))

    def compositor(self):
        screen = self.fn('XDefaultScreen', I)()
        atom = self.fn('XInternAtom', U, C.c_char_p, I)(f'_NET_WM_CM_S{screen}'.encode(), 1)
        owner = self.fn('XGetSelectionOwner', U, U)(atom) if atom else 0
        self.sync()
        if not owner:
            fail('NATIVE_COMPOSITOR_UNAVAILABLE', 'An existing X11 compositing manager is required; observer never redirects windows')
        return owner

    def capture(self, xid, pid, expected, compositor):
        pixmap, image = 0, None
        self.fn('XGrabServer', I)()
        try:
            if self.compositor() != compositor:
                fail('NATIVE_WINDOW_CHANGED', 'Compositing manager changed after selection')
            if self.pid(xid) != pid or self.geometry(xid) != expected:
                fail('NATIVE_WINDOW_CHANGED', 'Selected X11 owner or geometry changed')
            self.assert_descendants_owned(xid, pid)
            pixmap = bind(self.composite, 'XCompositeNameWindowPixmap', U, P, U)(self.display, xid)
            self.sync()
            if not pixmap:
                fail('NATIVE_SCREENSHOT_FAILED', 'Selected window has no Composite pixmap')
            image = self.fn('XGetImage', P, U, I, I, C.c_uint, C.c_uint, U, I)(pixmap, 0, 0, expected['width'], expected['height'], U(-1).value, 2)
            self.sync()
            if not image:
                fail('NATIVE_SCREENSHOT_FAILED', 'Cannot read selected window pixmap')
        finally:
            if pixmap:
                self.fn('XFreePixmap', I, U)(pixmap)
            self.fn('XUngrabServer', I)()
            self.fn('XFlush', I)()
        try:
            im = C.cast(image, C.POINTER(XImage)).contents
            if (im.width, im.height) != (expected['width'], expected['height']):
                fail('NATIVE_COORDINATE_MISMATCH', 'Pixmap dimensions differ from selected client geometry')
            return png_from_ximage(im)
        finally:
            if image:
                bind(self.lib, 'XDestroyImage', I, P)(image)


def collect(a, root, pid, origin, max_depth=64, max_nodes=10000):
    nodes, diagnostics, seen, ids = [], [], set(), set()
    truncated, errors = 0, 0
    stack = [(root, 0, 0, '')]
    while stack:
        obj, depth, ordinal, parent = stack.pop()
        if len(nodes) >= max_nodes or depth > max_depth:
            truncated += 1
            continue
        if obj in seen:
            diagnostics.append(dict(code='NATIVE_AX_CYCLE'))
            truncated += 1
            continue
        seen.add(obj)
        try:
            if a.pid(obj) != pid:
                diagnostics.append(dict(code='NATIVE_AX_FOREIGN_SUBTREE'))
                truncated += 1
                continue
            platform_role = a.text('accessible_get_role_name', obj)
            role = ROLES.get(platform_role, platform_role) or 'unknown'
            # role is data, never structural path syntax.
            segment = re.sub(r'[^A-Za-z0-9_-]', '_', role) + f'[{ordinal}]'
            path = parent + '>' + segment if parent else segment
            bounds = a.bounds(obj)
            if bounds is None or bounds['width'] < 0 or bounds['height'] < 0:
                diagnostics.append(dict(code='NATIVE_AX_MISSING_GEOMETRY', path=path))
                errors += 1
                # Preserve descendants without inventing a rectangle for this node.
            else:
                node = dict(path=path, role=role, platformRole=platform_role,
                            rect=rect(bounds['left'] - origin['left'], bounds['top'] - origin['top'], bounds['width'], bounds['height']))
                for field, method in [('name', 'accessible_get_name'), ('identifier', 'accessible_get_accessible_id')]:
                    try:
                        value = a.text(method, obj)
                        if value:
                            node[field] = value
                            if field == 'identifier':
                                if value in ids:
                                    diagnostics.append(dict(code='NATIVE_AX_DUPLICATE_IDENTIFIER', identifier=value))
                                ids.add(value)
                    except (Failure, AttributeError):
                        errors += 1
                try:
                    node['states'] = a.states(obj)
                except Failure:
                    errors += 1
                # Report native action names only, never synthesize tap from role.
                try:
                    action = a.obj('accessible_get_action_iface', obj, error=False)
                    if action:
                        n = a.call('action_get_n_actions', action, result=I)
                        if not 0 <= n <= 128:
                            raise Failure('NATIVE_AX_TRUNCATED', 'Action count exceeds bound')
                        actions = []
                        for index in range(n):
                            ptr = a.call('action_get_action_name', action, (index,), (I,))
                            if ptr:
                                actions.append('atspi:' + C.string_at(ptr).decode('utf-8', 'replace'))
                                a.free(ptr)
                        if actions:
                            node['actions'] = actions
                except Failure:
                    errors += 1
                nodes.append(node)
            children = list(a.children(obj))
            stack.extend((child, depth + 1, index, path) for index, child in reversed(children))
        except Failure as error:
            if error.code == 'NATIVE_AX_TIMEOUT':
                truncated += len(stack) + 1
                diagnostics.append(dict(code=error.code))
                break
            errors += 1
            diagnostics.append(dict(code=error.code))
    return nodes, dict(nodes=len(nodes), truncated=truncated, attributeErrors=errors), diagnostics


def write_artifacts(tree_path, png_path, tree, png):
    for path in (tree_path, png_path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(png_path).write_bytes(png)
    Path(tree_path).write_text(json.dumps(tree, ensure_ascii=False) + '\n')


class Agent:
    def __init__(self):
        self.sessions = {}
        self.x = self.a = None

    def close(self):
        for session in self.sessions.values():
            if session.get('selectedObj') and self.a:
                self.a.unref(session['selectedObj'])
        self.sessions.clear()
        if self.a:
            self.a.release()
        if self.x and self.x.display:
            self.x.fn('XCloseDisplay', I)()
            self.x.display = None

    def backend(self):
        if os.environ.get('WAYLAND_DISPLAY') or os.environ.get('XDG_SESSION_TYPE') == 'wayland':
            fail('NATIVE_WAYLAND_UNSUPPORTED', 'Wayland/XWayland unsupported: portal-to-accessibility identity mapping is not implemented')
        if not os.environ.get('DISPLAY'):
            fail('NATIVE_DISPLAY_UNAVAILABLE', 'DISPLAY is not set; an X11 desktop is required')
        if not os.environ.get('DBUS_SESSION_BUS_ADDRESS'):
            fail('NATIVE_ACCESSIBILITY_UNAVAILABLE', 'A desktop session bus is required')
        if self.x is None:
            self.x = X11()
        self.x.compositor()
        if self.a is None:
            self.a = Atspi()
        self.a.deadline = time.monotonic() + 15

    def doctor(self):
        checks = []
        try:
            self.backend()
            desktop = self.a.obj('get_desktop', args=(0,), types=(I,), error=False)
            accessible = bool(desktop)
            checks.append(dict(id='atspi', status='pass' if accessible else 'fail', message='AT-SPI desktop reachable' if accessible else 'AT-SPI desktop unavailable'))
            screen = True
            checks.append(dict(id='x11-composite', status='pass', message='X11, Composite and an existing compositor available; individual target backing is checked separately'))
        except (Failure, OSError) as e:
            accessible = screen = False
            checks.append(dict(id=getattr(e, 'code', 'NATIVE_DEPENDENCY_MISSING'), status='fail', message=str(e)))
        finally:
            if self.a:
                self.a.release()
        return dict(platform='linux', backend='x11', accessibility=dict(available=accessible),
                    screenCapture=dict(available=screen), checks=checks,
                    limitations=['X11 trusted local session only', 'Client frame, 1 X11 coordinate unit per pixel',
                                 'No Wayland/XWayland, launch, input, focus or termination',
                                 'AT-SPI root must uniquely match X11 client geometry; decorated mismatches are refused'])

    def session(self, params):
        session = self.sessions.get(params.get('sessionId'))
        if not session:
            fail('NATIVE_TARGET_NOT_FOUND', 'Unknown session')
        if process_identity(session['pid']) != session['identity']:
            fail('NATIVE_TARGET_EXITED', 'Target PID was reused')
        return session

    def windows(self, session):
        linked = associate(self.a.windows(session['pid']), self.x.windows(session['pid']))
        return [dict(w, windowId='window[x11:' + str(w['xid']) + ']', axPath=f'window[{w["index"]}]',
                     frameGlobalPoints=w['rect'], focused=w['states'].get('focused', False),
                     main=False, minimized=False, onScreen=True, screenCaptureWindowId=w['xid'], frameKind='client-window') for w in linked]

    @staticmethod
    def public(w):
        return {k: v for k, v in w.items() if k not in ('obj', 'states', 'rect', 'index', 'xid', 'pid')}

    def dispatch(self, method, params):
        if method == 'hello':
            return dict(protocol=1, agentVersion='0.1.0', platform='linux', backend='x11',
                        capabilities=dict(accessibility=True, screenCapture=True, singleFrameCapture=True,
                                          observer=True, input=False, physicalPointer=False, physicalKeyboard=False, launch=False, wayland=False),
                        frameKind='client-window', scale=1)
        if method == 'doctor':
            if params.get('prompt'):
                fail('NATIVE_UNSUPPORTED_OPERATION', 'Doctor is passive; permission prompts are unsupported')
            return self.doctor()
        if method not in ('target.open', 'window.list', 'window.select', 'snapshot.capture', 'session.close'):
            fail('NATIVE_UNSUPPORTED_OPERATION', 'Observer-only protocol; operation unsupported')
        if method == 'session.close':
            if params.get('terminateIfLaunched'):
                fail('NATIVE_UNSUPPORTED_OPERATION', 'Target termination is unsupported')
            closed = self.sessions.pop(params.get('sessionId'), None)
            if closed and closed.get('selectedObj') and self.a:
                self.a.unref(closed['selectedObj'])
            return dict(closed=True)
        self.backend()
        if method == 'target.open':
            target = params.get('target', {})
            if not isinstance(target, dict) or target.get('by') != 'pid' or target.get('launchIfNeeded'):
                fail('NATIVE_UNSUPPORTED_TARGET', 'Linux supports PID attach only, without launch')
            pid = bounded_int(target.get('pid'), 0, 1, 2147483647)
            if pid <= 0:
                fail('NATIVE_INVALID_PARAMS', 'A positive PID is required')
            sid = str(uuid.uuid4())
            self.sessions[sid] = dict(pid=pid, identity=process_identity(pid), selected=None)
            return dict(sessionId=sid, pid=pid, launched=False)
        s = self.session(params)
        windows = self.windows(s)
        if method == 'window.list':
            return [self.public(w) for w in windows]
        if method == 'window.select':
            w = choose(windows, params.get('selector'))
            s['compositor'] = self.x.compositor()
            if s.get('selectedObj'):
                self.a.unref(s['selectedObj'])
            s['selectedObj'] = bind(self.a.gobj, 'g_object_ref', P, P)(w['obj'])
            s['selected'] = w['windowId']
            return self.public(w)
        if params.get('windowId') != s['selected'] or not s['selected']:
            fail('NATIVE_WINDOW_NOT_SELECTED', 'Capture requires the explicitly selected session window')
        w = choose(windows, dict(by='window-id', windowId=s['selected']))
        if w['obj'] != s.get('selectedObj'):
            fail('NATIVE_WINDOW_CHANGED', 'Selected accessibility window identity changed')
        max_depth = bounded_int(params.get('maxDepth'), 64, 0, 128)
        max_nodes = bounded_int(params.get('maxNodes'), 10000, 1, 10000)
        outputs = [params.get('outputTreePath'), params.get('outputPngPath')]
        if any(not isinstance(p, str) or not os.path.isabs(p) for p in outputs) or outputs[0] == outputs[1]:
            fail('NATIVE_INVALID_PARAMS', 'Distinct absolute tree and PNG output paths are required')
        nodes, counts, diagnostics = collect(self.a, w['obj'], s['pid'], w['rect'], max_depth, max_nodes)
        if not nodes:
            fail('NATIVE_AX_CANNOT_COMPLETE', 'No accessible nodes with trustworthy geometry')
        # Revalidate accessibility identity/geometry after traversal, before pixels.
        if self.a.pid(w['obj']) != s['pid'] or self.a.bounds(w['obj']) != w['rect']:
            fail('NATIVE_WINDOW_CHANGED', 'AT-SPI selected window changed during traversal')
        self.session(params)
        png = self.x.capture(w['xid'], s['pid'], w['rect'], s['compositor'])
        viewport = dict(width=w['rect']['width'], height=w['rect']['height'])
        tree = dict(format='vlmkit-a11y/1', platform='linux', viewport=viewport, scale=1,
                    frame=os.path.relpath(outputs[1], Path(outputs[0]).parent), nodes=nodes)
        diagnostics.append(dict(code='NATIVE_X11_CLIENT_FRAME', frameKind='client-window',
                                association='pid+unique-exact-screen-extents', atomic=False))
        try:
            write_artifacts(outputs[0], outputs[1], tree, png)
        except OSError as e:
            fail('NATIVE_OUTPUT_WRITE_FAILED', str(e))
        return dict(treePath=outputs[0], pngPath=outputs[1], viewport=viewport, framePixels=viewport,
                    scale=1, frameKind='client-window', backend='x11', identity=dict(pid=s['pid'], windowId=w['windowId']), counts=counts, diagnostics=diagnostics,
                    transform=dict(globalWindowOriginPoints=dict(x=w['rect']['left'], y=w['rect']['top']), logicalToPixelScale=1))


def main():
    agent = Agent()
    try:
        for line in sys.stdin:
            request_id = None
            try:
                if len(line) > 65536:
                    fail('NATIVE_INVALID_PARAMS', 'Request exceeds 64 KiB')
                req = json.loads(line)
                if not isinstance(req, dict):
                    fail('NATIVE_INVALID_PARAMS', 'Request must be an object')
                request_id = req.get('id')
                if type(request_id) is not int or request_id < 0:
                    fail('NATIVE_INVALID_PARAMS', 'Request ID must be a nonnegative integer')
                if req.get('protocol') != 1:
                    fail('NATIVE_PROTOCOL_MISMATCH', 'Expected protocol 1')
                if not isinstance(req.get('params', {}), dict) or not isinstance(req.get('method'), str):
                    fail('NATIVE_INVALID_PARAMS', 'Invalid method or params')
                result = agent.dispatch(req['method'], req.get('params', {}))
                response = dict(id=request_id, ok=True, result=result)
            except Exception as e:
                response = dict(id=request_id, ok=False, error=dict(code=getattr(e, 'code', 'NATIVE_INTERNAL_ERROR'), message=str(e)))
            finally:
                if agent.a:
                    agent.a.release()
            print(json.dumps(response, ensure_ascii=False), flush=True)
    finally:
        agent.close()


if __name__ == '__main__':
    main()
