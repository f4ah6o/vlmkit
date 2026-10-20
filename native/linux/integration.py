#!/usr/bin/env python3
"""Run under dbus-run-session + Xvfb. Artifacts contain only these fixtures.

Two fixtures are driven against the real observer:
  * the base window (image / named / unnamed / entry / disabled) under a green
    foreign occluder, proving the selected client's own backing is captured;
  * the semantics matrix window, proving what AT-SPI announces for each control
    maps honestly into `vlmkit-a11y/1` (roles, identifiers, states, native action
    names) and that entry text and password values are never collected.
"""
import argparse
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import time
import traceback
import zlib

from observer import X11, I

HERE = Path(__file__).resolve().parent

# What the matrix window is expected to announce, per identifier. Roles are the
# AT-SPI role names the fixture's GTK widgets produce; the run records the actual
# tree, so a divergence fails here instead of being silently accepted.
MATRIX = {
    'fixture.save': dict(role='push button', name='Save', actions_any=['atspi:click']),
    'fixture.name': dict(role='entry', name='Name'),
    'fixture.secret': dict(role='password text', name='Secret'),
    'fixture.remember': dict(role='check box', name='Remember', states=['checked']),
    'fixture.toggle': dict(role='toggle button', name='Detail', actions_any=['atspi:click']),
    'fixture.mode.a': dict(role='radio button', name='Mode A', states=['checked']),
    'fixture.mode.b': dict(role='radio button', name='Mode B'),
    # GTK3 keeps no tab identifier (the notebook's accessible takes the last tab's
    # name and id), so the notebook is identified by its tab list and its
    # selected page; a page tab's own name is not announced reliably across GTK
    # versions either, and is recorded rather than required.
    'fixture.tabs': dict(role='page tab list', name='One', selected_page='First page', tab_state='selected'),
    'fixture.choice': dict(role='combo box', name='Choice'),
    'fixture.disabled': dict(role='push button', name='Disabled', states=['disabled']),
    'fixture.color': dict(role='image', name='Fixture color'),
}
# The normalized role each platform role must map to; `observer.ROLES` is the
# table under test, so the run fails if a mapping is lost rather than agreeing
# with whatever the observer produced.
observer_role = {
    'push button': 'button', 'entry': 'textfield', 'password text': 'textfield',
    'check box': 'checkbox', 'radio button': 'radio', 'page tab': 'tab',
    'combo box': 'combobox', 'toggle button': 'button', 'label': 'text', 'image': 'image',
}

# Platform-role names GTK may report for one control. A GTK3 GtkEntry labelled
# only by its accessible name is announced as `text`, even when the fixture names
# its ATK role (`Atk.Role.ENTRY`), and a hidden entry is `password text` or
# `entry` depending on the toolkit version. An accepted alternative is recorded
# as announced; what the matrix still holds is the no-value rule below.
MATRIX_ROLE_NAMES = {
    'fixture.name': ('entry', 'text'),
    'fixture.secret': ('password text', 'entry'),
}

# The normalized role expected for a matrix control, from its accepted names.
MATRIX_ROLE = {
    'fixture.save': 'button', 'fixture.name': 'textfield', 'fixture.secret': 'textfield',
    'fixture.remember': 'checkbox', 'fixture.toggle': 'button', 'fixture.mode.a': 'radio',
    'fixture.mode.b': 'radio', 'fixture.tabs': 'group',
    'fixture.choice': 'combobox', 'fixture.disabled': 'button', 'fixture.color': 'image',
}
# Controls a tree can lose without losing the test: the combo box's popup and a
# scrolled view's internals vary by GTK version. Their absence is recorded, not
# required, because no admission claim rests on them.
OPTIONAL = ('fixture.pages',)


class Client:
    def __init__(self):
        self.process = subprocess.Popen([sys.executable, str(HERE / 'observer.py')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.serial = 0
        self.history = []

    def request(self, method, params=None, error=None):
        self.serial += 1
        self.process.stdin.write(json.dumps(dict(id=self.serial, protocol=1, method=method, params=params or {})) + '\n')
        self.process.stdin.flush()
        assert select.select([self.process.stdout], [], [], 25)[0], f'{method} timed out'
        raw = self.process.stdout.readline()
        assert raw, f'Observer exited during {method}'
        response = json.loads(raw)
        self.history.append(dict(method=method, response=response))
        assert response['id'] == self.serial
        if error:
            assert not response['ok'] and response['error']['code'] == error, response
            return response
        assert response['ok'], response
        return response['result']

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=5)


def fixture(*args):
    env = dict(os.environ, GTK_MODULES='gail:atk-bridge', NO_AT_BRIDGE='0', GDK_BACKEND='x11')
    p = subprocess.Popen(['/usr/bin/python3', str(HERE / 'fixture.py'), *args], env=env, stdout=subprocess.PIPE, text=True)
    assert select.select([p.stdout], [], [], 15)[0], 'GTK fixture startup timed out'
    ready = json.loads(p.stdout.readline())
    assert ready['ready'] and ready['pid'] == p.pid
    return p


def stop(process):
    if process and process.poll() is None:
        process.terminate()
        process.wait(timeout=5)


def read_rgb_png(path):
    data = path.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    width, height = struct.unpack('!II', data[16:24])
    chunks, at = [], 8
    while at < len(data):
        length = struct.unpack('!I', data[at:at + 4])[0]
        kind = data[at + 4:at + 8]
        if kind == b'IDAT':
            chunks.append(data[at + 8:at + 8 + length])
        at += length + 12
    pixels = zlib.decompress(b''.join(chunks))
    assert len(pixels) == height * (width * 3 + 1)
    def pixel(x, y):
        assert 0 <= x < width and 0 <= y < height
        offset = y * (width * 3 + 1)
        assert pixels[offset] == 0
        return tuple(pixels[offset + 1 + x * 3:offset + 4 + x * 3])
    return width, height, pixel


def verify_occlusion_setup(x, selected, target_pid, foreign_pid):
    """Read-only proof for the admitted bare Xvfb/no-WM fixture profile."""
    target_xid = selected['screenCaptureWindowId']
    expected = selected['frameGlobalPoints']
    assert target_pid != foreign_pid, 'Occluder must belong to a different process'
    assert x.pid(target_xid) == target_pid, 'Selected fixture ownership changed'
    target_rect = x.geometry(target_xid)
    # geometry() only admits IsViewable InputOutput, zero-border client windows.
    assert target_rect == expected, ('Selected fixture is not viewable at expected geometry', target_rect)
    foreign_windows = x.windows(foreign_pid)
    assert len(foreign_windows) == 1, ('Expected one viewable foreign client', foreign_windows)
    foreign_window = foreign_windows[0]
    foreign_xid, foreign_rect = foreign_window['xid'], foreign_window['rect']
    assert foreign_rect == target_rect, ('Foreign fixture must exactly cover selected client', foreign_rect, target_rect)
    # XQueryTree children are bottom-to-top. This deliberately refuses WM
    # reparenting rather than weakening the controlled occlusion condition.
    root_children = x.children(x.root)
    assert target_xid in root_children and foreign_xid in root_children, 'Fixture clients must both be direct root children (no-WM profile)'
    target_index, foreign_index = root_children.index(target_xid), root_children.index(foreign_xid)
    assert foreign_index > target_index, ('Foreign fixture is not stacked above selected client', target_index, foreign_index)
    return dict(rootWindowId=x.root, selectedWindowId=target_xid, foreignWindowId=foreign_xid,
                selectedPid=target_pid, foreignPid=foreign_pid,
                selectedRect=target_rect, foreignRect=foreign_rect,
                selectedViewable=True, foreignViewable=True, directRootSiblings=True,
                stackingOrder='bottom-to-top', selectedStackIndex=target_index,
                foreignStackIndex=foreign_index, rootChildCount=len(root_children))


def wait_windows(client, sid, count, deadline=5.0):
    """A toolkit registers its accessibility window after the X11 one exists."""
    end = time.monotonic() + deadline
    windows = []
    while time.monotonic() < end:
        windows = client.request('window.list', dict(sessionId=sid))
        if len(windows) == count:
            return windows
        time.sleep(0.1)
    return windows


def by_identifier(tree):
    found = {}
    for node in tree['nodes']:
        identifier = node.get('identifier')
        if identifier:
            assert identifier not in found, ('A matrix control identifier is duplicated', identifier, node['path'])
            found[identifier] = node
    # The notebook has no identifier of its own; its tab list is the notebook, and
    # it announces the selected page by name, which is unique in this window.
    for node in tree['nodes']:
        if node.get('platformRole') == 'page tab list' and (node.get('name') or '').strip() not in ('', 'Pages'):
            found.setdefault('fixture.tabs', node)
            break
    return found


def capture_matrix(client, out):
    """The semantics matrix: one window, every control's announced facts."""
    app, x = fixture('--matrix'), None
    try:
        session = client.request('target.open', dict(target=dict(by='pid', pid=app.pid)))
        sid = session['sessionId']
        windows = wait_windows(client, sid, 1)
        assert len(windows) == 1, windows
        selected = windows[0]
        client.request('window.select', dict(sessionId=sid, selector=dict(by='window-id', windowId=selected['windowId'])))
        result = client.request('snapshot.capture', dict(
            sessionId=sid, windowId=selected['windowId'],
            outputTreePath=str(out / 'a11y.json'), outputPngPath=str(out / 'frame.png')))
        tree = json.loads((out / 'a11y.json').read_text())
        nodes = by_identifier(tree)
        observed = {}
        for identifier, expected in MATRIX.items():
            node = nodes.get(identifier)
            assert node is not None, ('Matrix control missing from the tree', identifier, sorted(tree))
            observed[identifier] = dict(role=node['role'], platformRole=node.get('platformRole'),
                                        name=node.get('name'), states=node.get('states'),
                                        actions=node.get('actions'),
                                        rect=node['rect'], value=node.get('value'))
            # GTK announces a hidden-entry as `password text` via get_role_name but
            # may report `entry` as its AtkRole; both map to `textfield` and neither
            # carries a value, so both are accepted by name.
            actual = observed[identifier]['platformRole']
            allowed = MATRIX_ROLE_NAMES.get(identifier, (expected['role'],))
            assert actual in allowed, (identifier, 'platform role', actual, allowed)
            if 'selected_page' in expected:
                # Exactly one tab is selected, and it carries the selected page's
                # label. A tab's own name is recorded in `observed`, not required:
                # GTK versions differ on whether it is announced at all.
                tabs = [n for n in tree['nodes'] if n.get('platformRole') == 'page tab'
                        and n['path'].startswith(node['path'] + '>')]
                assert tabs, (identifier, 'no page tab announced under the notebook', node['path'])
                chosen = [t for t in tabs if t.get('states', {}).get('selected') is True]
                assert len(chosen) == 1, (identifier, 'exactly one tab must be selected', [t['path'] for t in tabs])
                assert any(n.get('name') == expected['selected_page'] and n['path'].startswith(chosen[0]['path'] + '>')
                           for n in tree['nodes']), (identifier, 'the selected tab must carry the selected page label',
                                                     expected['selected_page'], chosen[0]['path'])
            # An accepted alternative name is recorded, not normalized away: a tree
            # that calls a labelled entry `text` is what the toolkit announced.
            assert node['role'] == observer_role.get(actual, actual), (identifier, 'role', actual, node['role'])
            assert node.get('name') == expected['name'], (identifier, 'name', node.get('name'), expected['name'])
            for state in expected.get('states', ()):
                assert node.get('states', {}).get(state) is True, (identifier, 'state', state, node.get('states'))
            for state in ('checked', 'selected', 'expanded', 'focused', 'hidden', 'disabled'):
                assert isinstance(node.get('states', {}).get(state, False), bool), (identifier, 'state value', state, node.get('states'))
            for action in expected.get('actions_any', ()):
                assert action in (node.get('actions') or ()), (identifier, 'action', action, node.get('actions'))
        # Values: entry text is content and is never collected; a password value
        # must never be collected, and neither may appear anywhere in the file.
        for identifier in ('fixture.name', 'fixture.secret'):
            assert observed[identifier]['value'] is None, (identifier, 'value must not be collected', observed[identifier]['value'])
        raw = (out / 'a11y.json').read_text()
        assert 'hunter2' not in raw and 'Fixture value' not in raw, 'Entry text leaked into the accessibility tree'
        # The unnamed button is still unnamed: the matrix plants one for the judge.
        unnamed = [n for n in tree['nodes'] if n['role'] == 'button' and not (n.get('name') or '').strip()]
        assert unnamed, 'The matrix must plant one unnamed button'
        width, height, pixel = read_rgb_png(out / 'frame.png')
        assert (width, height) == (tree['viewport']['width'], tree['viewport']['height']) == (360, 560), (width, height, tree['viewport'])
        x = X11()
        on_screen = x.geometry(selected['screenCaptureWindowId'])
        assert on_screen is not None and on_screen['width'] == 360 and on_screen['height'] == 560, on_screen
        color = observed['fixture.color']['rect']
        point = (int(color['left'] + color['width'] / 2), int(color['top'] + color['height'] / 2))
        assert pixel(*point) == (255, 0, 0), ('Matrix image rect must align with its red pixels', point, pixel(*point))
        report = dict(pid=app.pid, windowId=selected['windowId'], capture=result, tree=tree['nodes'],
                      observed=observed, unnamedButtons=[n['path'] for n in unnamed],
                      optional=fetch_identifiers(tree, OPTIONAL),
                      alignment=dict(imageRect=color, imagePoint=list(point), imageRgb=list(pixel(*point))))
        client.request('session.close', dict(sessionId=sid))
        assert app.poll() is None, 'close must detach, never terminate the target'
        report['checks'] = ['one-window selection', 'matrix roles/names/identifiers/states/actions',
                            'entry text and password values never collected',
                            'unnamed button preserved', 'image rect aligns with red pixels',
                            'close detaches only']
        return report
    finally:
        if x:
            x.fn('XCloseDisplay', I)()
        stop(app)


def fetch_identifiers(tree, identifiers):
    present = {n.get('identifier') for n in tree['nodes']}
    return {i: (i in present) for i in identifiers}


def capture_base(client, out):
    """The admitted slice: association, occlusion, pixels, bounds, exits."""
    app, foreign, x = None, None, None
    report = dict(checks=[])
    try:
        app = fixture('--two')
        session = client.request('target.open', dict(target=dict(by='pid', pid=app.pid)))
        sid = session['sessionId']
        windows = wait_windows(client, sid, 2)
        assert len(windows) == 2, windows
        assert windows[0]['title'] == windows[1]['title'], 'Fixture has duplicate titles intentionally'
        # Two ordinary windows with nothing focused: never pick one silently.
        client.request('window.select', dict(sessionId=sid, selector=None), error='NATIVE_WINDOW_AMBIGUOUS')
        report['checks'].append('ambiguous windows refuse implicit selection')
        selected = min(windows, key=lambda w: w['frameGlobalPoints']['left'])
        client.request('window.select', dict(sessionId=sid, selector=dict(by='window-id', windowId=selected['windowId'])))
        foreign = fixture('--foreign')  # Covers target with bright green pixels.
        x = X11()
        setup = verify_occlusion_setup(x, selected, app.pid, foreign.pid)
        foreign_png = x.capture(setup['foreignWindowId'], foreign.pid, setup['foreignRect'], x.compositor())
        (out / 'foreign.png').write_bytes(foreign_png)
        _, _, foreign_pixel = read_rgb_png(out / 'foreign.png')
        assert foreign_pixel(70, 50) == (0, 255, 0), 'Occluder fixture backing must actually contain green pixels'
        report['occlusion'] = dict(foreignFrame='foreign.png', fixtureColorPoint=dict(x=70, y=50),
                                   foreignFixtureRgb=list(foreign_pixel(70, 50)))
        params = dict(sessionId=sid, windowId=selected['windowId'], outputTreePath=str(out / 'a11y.json'), outputPngPath=str(out / 'frame.png'))
        report['occlusion']['beforeCapture'] = verify_occlusion_setup(x, selected, app.pid, foreign.pid)
        result = client.request('snapshot.capture', params)
        report['occlusion']['afterCapture'] = verify_occlusion_setup(x, selected, app.pid, foreign.pid)
        assert report['occlusion']['beforeCapture'] == report['occlusion']['afterCapture'], 'Occlusion setup changed during selected capture'

        tree = json.loads((out / 'a11y.json').read_text())
        assert tree['format'] == 'vlmkit-a11y/1' and tree['platform'] == 'linux'
        assert result['frameKind'] == 'client-window' and result['identity']['pid'] == app.pid
        assert result['viewport'] == dict(width=360, height=260)
        assert result['scale'] == tree['scale'] == 1
        assert result['counts']['truncated'] == 0, result
        # AT-SPI can answer no geometry for a widget GTK draws inside another
        # (the popdown's arrow, a cell renderer). That is a diagnostic, never an
        # invented rectangle; the matrix profile asserts the controls themselves.
        diagnostics = result['diagnostics']
        assert not [d for d in diagnostics if d['code'] not in ('NATIVE_AX_MISSING_GEOMETRY',
                                                                'NATIVE_X11_CLIENT_FRAME')], diagnostics
        report['baseDiagnostics'] = [d for d in diagnostics if d['code'] == 'NATIVE_AX_MISSING_GEOMETRY']
        report['checks'].append('no unexpected attribute diagnostics')
        save = next(n for n in tree['nodes'] if n.get('name') == 'Save')
        assert save['role'] == 'button', save
        assert save.get('identifier') == 'fixture.save', save
        color = next(n for n in tree['nodes'] if n.get('identifier') == 'fixture.color')
        width, height, pixel = read_rgb_png(out / 'frame.png')
        r = color['rect']
        point = (int(r['left'] + r['width'] / 2), int(r['top'] + r['height'] / 2))
        assert foreign_pixel(*point) == (0, 255, 0), ('Semantic test point must be covered by actual foreign green pixels', point)
        assert pixel(*point) == (255, 0, 0), ('Selected red client pixels must survive green foreign occlusion', pixel(*point))
        report['occlusion'].update(semanticPoint=dict(x=point[0], y=point[1]),
                                    selectedRgb=list(pixel(*point)), foreignRgb=list(foreign_pixel(*point)))
        report['checks'].extend(['duplicate-title same-PID windows', 'stable toolkit identifier', 'client-frame geometry',
                                 'semantic-rect pixel alignment', 'foreign occluder excluded'])
        entry = next((n for n in tree['nodes'] if n.get('identifier') == 'fixture.name'), None)
        assert entry is not None and 'value' not in entry, ('Entry text must not be collected', entry)
        assert 'Fixture value' not in (out / 'a11y.json').read_text(), 'Entry text leaked into the base tree'
        report['checks'].append('entry text is not collected')
        truncated = client.request('snapshot.capture', dict(params, maxNodes=1, outputTreePath=str(out / 'truncated.json'), outputPngPath=str(out / 'truncated.png')))
        assert truncated['counts']['nodes'] == 1 and truncated['counts']['truncated'] > 0
        report['checks'].append('bounded traversal reports truncation')
        client.request('snapshot.capture', dict(params, windowId='window[x11:0]'), error='NATIVE_WINDOW_NOT_SELECTED')
        client.request('input.click', {}, error='NATIVE_UNSUPPORTED_OPERATION')
        client.request('session.close', dict(sessionId=sid, terminateIfLaunched=True), error='NATIVE_UNSUPPORTED_OPERATION')
        stop(app)
        client.request('window.list', dict(sessionId=sid), error='NATIVE_TARGET_EXITED')
        report['checks'].append('target exit is NATIVE_TARGET_EXITED')
        client.request('session.close', dict(sessionId=sid))
        report['checks'].extend(['capture selected-window binding', 'physical input denied', 'close detaches only'])
        report.update(capture=result)
        return report
    finally:
        if x:
            x.fn('XCloseDisplay', I)()
        stop(foreign)
        stop(app)


def partial_association(out):
    """X11 clients with no AT-SPI bridge are a partial profile, not an empty app.

    The X11-only fixture is a plain Xlib window: no toolkit, so no AT-SPI app.
    The observer must say NATIVE_AX_PARTIAL, never `NATIVE_WINDOW_NOT_FOUND`
    (which reads as "the app has no window") and never a fabricated tree.
    """
    xlib = None
    for candidate in ('python3-xlib', 'Xlib'):
        try:
            __import__(candidate)
            xlib = candidate
            break
        except ImportError:
            continue
    if xlib is None:
        return dict(outcome='UNRUN', reason='python3-xlib is not installed; no X11-only fixture available')
    script = (
        'import Xlib.display, time\n'
        'd = Xlib.display.Display()\n'
        's = d.screen()\n'
        'w = s.root.create_window(0, 0, 80, 60, 0, s.root_depth, 1)\n'
        'w.map(); d.sync(); print("ready", flush=True); time.sleep(60)\n'
    )
    process = subprocess.Popen([sys.executable, '-c', script], stdout=subprocess.PIPE, text=True)
    try:
        assert select.select([process.stdout], [], [], 10)[0], 'X11-only fixture startup timed out'
        assert process.stdout.readline().strip() == 'ready'
        client = Client()
        try:
            hello = client.request('hello')
            session = client.request('target.open', dict(target=dict(by='pid', pid=process.pid)))
            response = client.request('window.list', dict(sessionId=session['sessionId']), error='NATIVE_AX_PARTIAL')
            (out / 'partial.json').write_text(json.dumps(dict(hello=hello, response=response), indent=2) + '\n')
            return dict(outcome='PASS', profile='X11-only client, no AT-SPI bridge',
                        result=response['error'])
        finally:
            client.close()
    finally:
        stop(process)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default='test-results/native/linux')
    args = parser.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    client = None
    report = dict(platform='linux', backend='x11', checks=[], profiles={})
    try:
        client = Client()
        hello = client.request('hello')
        assert hello['platform'] == 'linux' and hello['capabilities']['physicalPointer'] is False
        doctor = client.request('doctor', dict(prompt=False))
        assert doctor['accessibility']['available'] and doctor['screenCapture']['available'], doctor
        report['hello'], report['doctor'] = hello, doctor
        report['profiles']['base'] = capture_base(client, out)
        report['checks'].extend(report['profiles']['base'].pop('checks'))
        matrix_out = out / 'matrix'
        matrix_out.mkdir(parents=True, exist_ok=True)
        report['profiles']['matrix'] = capture_matrix(client, matrix_out)
        report['checks'].append('GTK semantics matrix: roles, identifiers, states, actions')
        report['checks'].append('entry text and password values never collected')
        partial = partial_association(out)
        report['profiles']['partial-association'] = partial
        report['checks'].append(f"partial association: {partial['outcome']} ({partial.get('reason', 'NATIVE_AX_PARTIAL')})")
        report.update(passed=True)
        (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    except Exception as error:
        report.update(passed=False, error=str(error), traceback=traceback.format_exc(),
                      protocol=client.history if client else [])
        (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        raise
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    main()
