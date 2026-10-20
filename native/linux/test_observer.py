"""Pure contract/ownership/geometry tests, no display or D-Bus needed."""
import ctypes as C
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import unittest
import tempfile
from unittest.mock import Mock, patch
import zlib

import observer as o
from integration import verify_occlusion_setup


class TreeAtspi:
    """In-memory AT-SPI-shaped tree used to check traversal without a desktop."""
    def __init__(self, children=None, foreign=(), geometryless=()):
        self.tree = children or {}
        self.foreign = set(foreign)
        self.geometryless = set(geometryless)
        self.child_fetches = []

    def pid(self, obj): return 101 if obj in self.foreign else 100
    def text(self, name, obj):
        if name == 'accessible_get_role_name': return 'push button'
        if name == 'accessible_get_name': return ''
        if name == 'accessible_get_accessible_id': return 'real-id'
        raise AssertionError(name)
    def bounds(self, obj):
        return None if obj in self.geometryless else o.rect(-90, 25, 20, 10)
    def states(self, obj): return {}
    def obj(self, *args, **kwargs): return None
    def child_count(self, obj): return len(self.tree.get(obj, ()))
    def child_at(self, obj, index):
        self.child_fetches.append((obj, index))
        return self.tree[obj][index]


class BudgetTreeAtspi(TreeAtspi, o.Atspi):
    """Tree fixture using Atspi's real per-request reference accounting."""
    def __init__(self, children, reference_limit):
        TreeAtspi.__init__(self, children)
        self.refs = []
        self.visited_used = 0
        self.visited_limit = o.MAX_AX_VISITED
        self.references_used = 0
        self.references_limit = reference_limit
        self.unref = Mock()

    def obj(self, name, obj=None, args=(), types=(), error=True, critical=False):
        self.reserve_reference(critical=critical)
        if name == 'accessible_get_component_iface':
            value = ('component', obj)
            self.refs.append(value)
            return value
        if name == 'accessible_get_child_at_index':
            value = self.tree[obj][args[0]]
            self.refs.append(value)
            self.child_fetches.append((obj, args[0]))
            return value
        return None

    def child_at(self, obj, index):
        self.reserve_visit()
        return self.obj('accessible_get_child_at_index', obj, (index,), (int,))

    def bounds(self, obj, critical=False):
        self.obj('accessible_get_component_iface', obj, error=False, critical=critical)
        return None if obj in self.geometryless else o.rect(-90, 25, 20, 10)


class ObserverTests(unittest.TestCase):
    def test_occlusion_fixture_rejects_absent_or_reversed_overlap(self):
        bounds = o.rect(80, 80, 360, 260)
        selected = dict(screenCaptureWindowId=10, frameGlobalPoints=bounds)
        class FakeX:
            root = 1
            order = [10, 20]
            foreign_rect = bounds
            def pid(self, xid): return 100
            def geometry(self, xid): return bounds
            def windows(self, pid): return [dict(xid=20, pid=pid, rect=self.foreign_rect)]
            def children(self, xid): return self.order
        x = FakeX()
        proof = verify_occlusion_setup(x, selected, 100, 200)
        self.assertGreater(proof['foreignStackIndex'], proof['selectedStackIndex'])
        for order in ([20, 10], [10]):
            x.order = order
            with self.assertRaises(AssertionError):
                verify_occlusion_setup(x, selected, 100, 200)
        x.order = [10, 20]
        x.foreign_rect = o.rect(81, 80, 360, 260)
        with self.assertRaises(AssertionError):
            verify_occlusion_setup(x, selected, 100, 200)

    def test_association_never_uses_title(self):
        r = o.rect(-30, 45, 300, 200)
        a = dict(pid=10, rect=r, title='same')
        w = dict(pid=11, rect=r, xid=20, title='same')
        self.assertEqual(o.associate([a], [w]), [])
        w['pid'] = 10
        w['title'] = 'different'
        self.assertEqual(o.associate([a], [w])[0]['xid'], 20)
        self.assertEqual(o.associate([a, a], [w]), [])
        self.assertEqual(o.associate([a], [w, dict(w, xid=21)]), [])
        self.assertEqual(o.associate([a], [dict(w, rect=o.rect(-30, 44, 300, 200))]), [])

    def test_selection_ambiguity(self):
        a = dict(windowId='window[x11:1]', focused=False, main=False)
        b = dict(windowId='window[x11:2]', focused=False, main=False)
        with self.assertRaisesRegex(o.Failure, 'Select one'):
            o.choose([a, b])
        self.assertEqual(o.choose([a, b], dict(by='index', index=1)), b)
        self.assertEqual(o.choose([a]), a)
        self.assertEqual(o.choose([a, dict(b, focused=True)])['windowId'], b['windowId'])
        with self.assertRaises(o.Failure):
            o.choose([a], dict(by='index', index=True))

    def test_wayland_and_no_display_fail_closed(self):
        for env, code in [({}, 'NATIVE_DISPLAY_UNAVAILABLE'),
                          ({'DISPLAY': ':1', 'WAYLAND_DISPLAY': 'wayland-0'}, 'NATIVE_WAYLAND_UNSUPPORTED'),
                          ({'DISPLAY': ':1', 'XDG_SESSION_TYPE': 'wayland'}, 'NATIVE_WAYLAND_UNSUPPORTED')]:
            with patch.dict(os.environ, env, clear=True):
                doctor = o.Agent().doctor()
            self.assertFalse(doctor['accessibility']['available'])
            self.assertFalse(doctor['screenCapture']['available'])
            self.assertEqual(doctor['checks'][0]['id'], code)

    def test_no_atspi_bridge_is_partial_never_an_empty_app(self):
        agent = o.Agent()
        agent.x = Mock()
        agent.x.windows.return_value = [dict(xid=5, pid=100, rect=o.rect(0, 0, 80, 60))]
        agent.a = Mock()
        agent.a.windows.return_value = ([], 0)
        with self.assertRaises(o.Failure) as caught:
            agent.windows(dict(pid=100))
        self.assertEqual(caught.exception.code, 'NATIVE_AX_PARTIAL')
        # The counts travel with the error as machine-readable details; the
        # caller retrying a toolkit bridge does not have to parse the message.
        self.assertEqual(caught.exception.details['x11Windows'], 1)
        self.assertEqual(caught.exception.details['atspiWindows'], 0)
        self.assertEqual(caught.exception.details['atspiApps'], 0)

    def test_partial_association_is_evidence_on_the_session(self):
        agent = o.Agent()
        agent.x = Mock()
        agent.x.windows.return_value = [dict(xid=5, pid=100, rect=o.rect(0, 0, 80, 60))]
        agent.a = Mock()
        agent.a.windows.return_value = ([], 0)
        session = dict(pid=100)
        with self.assertRaises(o.Failure):
            agent.windows(session)
        self.assertEqual(session['diagnostics'][0]['code'], 'NATIVE_AX_PARTIAL')
        self.assertEqual(session['diagnostics'][0]['x11Windows'], 1)
        # Once the toolkit's bridge answers, the stale evidence is cleared.
        agent.a.windows.return_value = ([dict(obj=9, pid=100, rect=o.rect(0, 0, 80, 60), index=0,
                                              title='t', states={})], 1)
        linked = agent.windows(session)
        self.assertEqual([w['windowId'] for w in linked], ['window[x11:5]'])
        self.assertNotIn('diagnostics', session)

    def test_agent_errors_are_machine_readable_codes(self):
        for code in ('NATIVE_AX_PARTIAL', 'NATIVE_TARGET_EXITED', 'NATIVE_WINDOW_AMBIGUOUS',
                     'NATIVE_AX_VISIT_LIMIT', 'NATIVE_AX_REFERENCE_LIMIT'):
            failure = o.Failure(code, code)
            self.assertEqual(failure.code, code)
            self.assertEqual(str(failure), code)

    def test_no_input_or_termination(self):
        agent = o.Agent()
        hello = agent.dispatch('hello', {})
        self.assertFalse(hello['capabilities']['physicalPointer'])
        self.assertFalse(hello['capabilities']['physicalKeyboard'])
        for method, params in [('click', {}), ('input.key', {}), ('window.focus', {}),
                               ('session.close', {'terminateIfLaunched': True}), ('doctor', {'prompt': True})]:
            with self.assertRaises(o.Failure):
                agent.dispatch(method, params)

    def test_pid_reuse(self):
        agent = o.Agent()
        agent.sessions['s'] = dict(pid=123, identity='old')
        with patch.object(o, 'process_identity', return_value='new'):
            with self.assertRaisesRegex(o.Failure, 'reused'):
                agent.session(dict(sessionId='s'))

    def test_png_pixel_layout_and_geometry(self):
        raw = C.create_string_buffer(bytes([30, 20, 10, 0, 60, 50, 40, 0]))
        image = o.XImage(width=2, height=1, data=C.cast(raw, o.P), byte_order=0,
                         depth=24, bytes_per_line=8, bits_per_pixel=32,
                         red_mask=0xff0000, green_mask=0xff00, blue_mask=0xff)
        png = o.png_from_ximage(image)
        self.assertEqual(struct.unpack('!II', png[16:24]), (2, 1))
        size = struct.unpack('!I', png[33:37])[0]
        self.assertEqual(zlib.decompress(png[41:41 + size]), bytes([0, 10, 20, 30, 40, 50, 60]))
        image.depth = 32
        with self.assertRaises(o.Failure):
            o.png_from_ximage(image)
        image.depth = 24
        image.red_mask = 0xf800
        with self.assertRaises(o.Failure):
            o.png_from_ximage(image)

    def test_pixmap_zero_masks_require_verified_selected_visual(self):
        raw = C.create_string_buffer(bytes([30, 20, 10, 0]))
        image = o.XImage(width=1, height=1, data=C.cast(raw, o.P), byte_order=0,
                         depth=24, bytes_per_line=4, bits_per_pixel=32)
        visual = dict(depth=24, **{'class': 4}, bitsPerRgb=8, colormapSize=256,
                      masks=(0xff0000, 0xff00, 0xff))
        png = o.png_from_ximage(image, visual)
        size = struct.unpack('!I', png[33:37])[0]
        self.assertEqual(zlib.decompress(png[41:41 + size]), bytes([0, 10, 20, 30]))
        for invalid in [None, dict(visual, **{'class': 5}), dict(visual, depth=32),
                        dict(visual, masks=(0, 0, 0)), dict(visual, bitsPerRgb=6)]:
            with self.assertRaises(o.Failure):
                o.png_from_ximage(image, invalid)
        image.red_mask, image.green_mask, image.blue_mask = 0xff, 0xff00, 0xff0000
        with self.assertRaisesRegex(o.Failure, 'disagree'):
            o.png_from_ximage(image, visual)

    def test_traversal_bounds_identifiers_negative_origin(self):
        fake = TreeAtspi({1: [2, 3, 5]}, foreign=[5])
        nodes, counts, diagnostics = o.collect(fake, 1, 100, o.rect(-100, 20, 100, 100))
        self.assertEqual(nodes[0]['rect'], o.rect(10, 5, 20, 10))
        self.assertEqual(nodes[0]['identifier'], 'real-id')
        self.assertNotIn('actions', nodes[0])
        self.assertEqual(len({n['path'] for n in nodes}), 3)
        self.assertEqual(counts['truncated'], 1)
        self.assertTrue(any(d['code'] == 'NATIVE_AX_DUPLICATE_IDENTIFIER' for d in diagnostics))
        fake = TreeAtspi({1: [2, 3, 5]}, foreign=[5])
        _, counts, _ = o.collect(fake, 1, 100, o.rect(0, 0, 1, 1), max_nodes=1)
        self.assertEqual(counts['nodes'], 1)
        self.assertEqual(counts['truncated'], 3)
        self.assertEqual(fake.child_fetches, [], 'maxNodes must stop before acquiring child references')
        fake = TreeAtspi({1: [2, 3, 5]}, foreign=[5])
        _, counts, _ = o.collect(fake, 1, 100, o.rect(0, 0, 1, 1), max_depth=0)
        self.assertEqual(counts['nodes'], 1)
        self.assertEqual(counts['truncated'], 3)
        self.assertEqual(fake.child_fetches, [], 'maxDepth must stop before acquiring child references')

    def test_wide_geometryless_tree_stops_at_visited_budget_before_acquisition(self):
        fake = TreeAtspi({1: list(range(2, 12))}, geometryless=range(1, 12))
        nodes, counts, diagnostics = o.collect(fake, 1, 100, o.rect(0, 0, 1, 1), max_nodes=1, max_visited=4)
        self.assertEqual(nodes, [])
        # A visit is charged once per entered node: the root, then three more
        # children fit in a budget of 4. The remaining seven are truncated.
        self.assertEqual(len(fake.child_fetches), 3)
        self.assertEqual(counts['truncated'], 7)
        self.assertTrue(any(d['code'] == 'NATIVE_AX_VISIT_LIMIT' for d in diagnostics))

    def test_lazy_cycle_deep_and_foreign_tree_edges_are_bounded(self):
        cyclic = TreeAtspi({1: [2], 2: [1]})
        nodes, counts, diagnostics = o.collect(cyclic, 1, 100, o.rect(0, 0, 1, 1))
        self.assertEqual(counts['nodes'], 2)
        self.assertEqual(counts['truncated'], 1)
        self.assertTrue(any(d['code'] == 'NATIVE_AX_CYCLE' for d in diagnostics))

        deep = TreeAtspi({1: [2], 2: [3], 3: [4], 4: []})
        nodes, counts, diagnostics = o.collect(deep, 1, 100, o.rect(0, 0, 1, 1), max_depth=2)
        self.assertEqual(counts['nodes'], 3)
        self.assertEqual(counts['truncated'], 1)
        self.assertEqual(deep.child_fetches, [(1, 0), (2, 0)])
        self.assertTrue(any(d['code'] == 'NATIVE_AX_DEPTH_LIMIT' for d in diagnostics))

        foreign = TreeAtspi({1: [2, 3]}, foreign=[2])
        nodes, counts, diagnostics = o.collect(foreign, 1, 100, o.rect(0, 0, 1, 1))
        self.assertEqual(counts['nodes'], 2)
        self.assertEqual(counts['truncated'], 1)
        self.assertTrue(any(d['code'] == 'NATIVE_AX_FOREIGN_SUBTREE' for d in diagnostics))

    def test_visit_limit_exact_boundary_and_reference_reservation(self):
        # Root + one child = 2 entered nodes and 2 visits: the root is charged
        # like any other node, and a child is charged exactly once.
        exact = TreeAtspi({1: [2]})
        _, counts, _ = o.collect(exact, 1, 100, o.rect(0, 0, 1, 1), max_visited=3)
        self.assertEqual(counts['nodes'], 2)
        self.assertEqual(counts['truncated'], 0)
        self.assertEqual(exact.child_fetches, [(1, 0)])

        fits = TreeAtspi({1: [2]})
        _, counts, _ = o.collect(fits, 1, 100, o.rect(0, 0, 1, 1), max_visited=2)
        self.assertEqual(counts['nodes'], 2)
        self.assertEqual(counts['truncated'], 0)
        self.assertEqual(fits.child_fetches, [(1, 0)])

        exhausted = TreeAtspi({1: [2]})
        _, counts, diagnostics = o.collect(exhausted, 1, 100, o.rect(0, 0, 1, 1), max_visited=1)
        self.assertEqual(counts['nodes'], 1)
        self.assertEqual(counts['truncated'], 1)
        # The remaining child must not be acquired once the budget is spent.
        self.assertEqual(exhausted.child_fetches, [])
        self.assertTrue(any(d['code'] == 'NATIVE_AX_VISIT_LIMIT' for d in diagnostics))

        limited = TreeAtspi({1: [2]})
        limited.child_at = lambda _obj, _index: (_ for _ in ()).throw(
            o.Failure('NATIVE_AX_REFERENCE_LIMIT', 'request reference budget exhausted'))
        _, counts, diagnostics = o.collect(limited, 1, 100, o.rect(0, 0, 1, 1))
        self.assertEqual(counts['nodes'], 1)
        self.assertEqual(counts['truncated'], 1)
        self.assertTrue(any(d['code'] == 'NATIVE_AX_REFERENCE_LIMIT' for d in diagnostics))

        a = object.__new__(o.Atspi)
        a.refs = []
        a.visited_used = 0
        a.visited_limit = 0
        a.references_used = 0
        a.references_limit = 2
        a.call = Mock()
        with self.assertRaisesRegex(o.Failure, 'visited-node budget') as caught:
            a.child_at(10, 0)
        self.assertEqual(caught.exception.code, 'NATIVE_AX_VISIT_LIMIT')
        a.call.assert_not_called()

        a = object.__new__(o.Atspi)
        a.refs = []
        a.visited_used = 1
        a.visited_limit = 1
        a.references_used = 0
        a.references_limit = 2
        a.unref = Mock()
        a.call = Mock(return_value=77)
        self.assertEqual(a.obj('first'), 77)
        with self.assertRaisesRegex(o.Failure, 'reference budget') as caught:
            a.obj('must-not-be-called')
        self.assertEqual(caught.exception.code, 'NATIVE_AX_REFERENCE_LIMIT')
        self.assertEqual(a.call.call_count, 1, 'reference budget must be checked before the next AT-SPI call')
        self.assertEqual(a.references_used, 1)

        a.begin_request()
        self.assertEqual(a.references_used, 0)
        self.assertEqual(a.visited_used, 0)
        self.assertEqual(a.refs, [])
        a.references_limit = 2
        a.call = Mock(side_effect=[88, 99])
        self.assertEqual(a.obj('next-request'), 88)
        self.assertEqual(a.references_used, 1)
        self.assertEqual(a.obj('reserved-revalidation', critical=True), 99)
        self.assertEqual(a.references_used, 2)
        with self.assertRaises(o.Failure):
            a.obj('after-hard-limit')
        self.assertEqual(a.call.call_count, 2)
        a.release()
        a.unref.assert_any_call(77)
        a.unref.assert_any_call(88)
        a.unref.assert_any_call(99)
        self.assertEqual(a.references_used, 0)

    def test_atspi_children_iterator_does_not_eagerly_acquire(self):
        a = object.__new__(o.Atspi)
        a.refs = []
        a.visited_used = 0
        a.visited_limit = 10
        a.references_used = 0
        a.references_limit = 10
        a.call = Mock(side_effect=[3, 11, 12, 13])
        children = a.children(1)
        self.assertEqual(a.call.call_count, 0)
        self.assertEqual(next(children), (0, 11))
        self.assertEqual(a.call.call_count, 2)
        self.assertEqual(next(children), (1, 12))
        self.assertEqual(a.call.call_count, 3)
        self.assertEqual(a.references_used, 2)
        self.assertEqual(a.visited_used, 2)

        too_wide = object.__new__(o.Atspi)
        too_wide.refs = []
        too_wide.visited_used = 0
        too_wide.visited_limit = 10
        too_wide.references_used = 0
        too_wide.references_limit = 10
        too_wide.call = Mock(return_value=o.MAX_AX_CHILDREN + 1)
        with self.assertRaises(o.Failure) as caught:
            list(too_wide.children(1))
        self.assertEqual(caught.exception.code, 'NATIVE_AX_TRUNCATED')
        too_wide.call.assert_called_once()

    def test_request_cleanup_runs_when_dispatch_fails(self):
        agent = o.Agent()
        agent.a = Mock()
        with self.assertRaises(o.Failure):
            agent.dispatch('unsupported', {})
        agent.a.begin_request.assert_called_once_with()
        agent.a.release.assert_called_once_with()

    def test_selected_window_identity_outlives_request_ref_cleanup(self):
        agent = o.Agent()
        agent.a = Mock()
        agent.a.gobj = object()
        agent.x = Mock()
        agent.x.compositor.return_value = 'compositor-id'
        agent.sessions['session'] = dict(pid=123, identity='start', selected=None)
        window = dict(obj=77, windowId='window[x11:77]')
        with patch.object(agent, 'backend'), patch.object(agent, 'windows', return_value=[window]), \
                patch.object(o, 'process_identity', return_value='start'), \
                patch.object(o, 'bind', return_value=lambda obj: obj):
            agent.dispatch('window.select', dict(sessionId='session', selector=dict(by='window-id', windowId=window['windowId'])))
        self.assertEqual(agent.sessions['session']['selectedObj'], 77)
        self.assertEqual(agent.sessions['session']['selected'], window['windowId'])
        agent.a.release.assert_called_once_with()
        agent.a.unref.assert_not_called()

    def test_reference_boundary_returns_partial_capture_with_reserved_revalidation(self):
        tree = BudgetTreeAtspi({77: [78, 79], 78: [], 79: []}, reference_limit=6)
        agent = o.Agent()
        agent.a = tree
        agent.x = Mock()
        agent.x.capture.return_value = b'png-bytes'
        window_id = 'window[x11:77]'
        agent.sessions['session'] = dict(pid=100, identity='start', selected=window_id,
                                         selectedObj=77, compositor='existing-compositor')
        window = dict(obj=77, pid=100, rect=o.rect(-90, 25, 20, 10), index=0,
                      title='', states={}, xid=77, windowId=window_id)
        with tempfile.TemporaryDirectory() as base:
            tree_path = str(Path(base) / 'tree' / 'a11y.json')
            png_path = str(Path(base) / 'frames' / 'frame.png')
            params = dict(sessionId='session', windowId=window_id,
                          outputTreePath=tree_path, outputPngPath=png_path)
            with patch.object(agent, 'backend'), patch.object(agent, 'windows', return_value=[window]), \
                    patch.object(o, 'process_identity', return_value='start'):
                result = agent.dispatch('snapshot.capture', params)
            saved_tree = json.loads(Path(tree_path).read_text())
            self.assertEqual(result['counts']['nodes'], 2)
            self.assertEqual(result['counts']['truncated'], 1)
            self.assertIn('NATIVE_AX_REFERENCE_LIMIT', [d['code'] for d in result['diagnostics']])
            self.assertEqual(len(saved_tree['nodes']), 2)
            self.assertEqual(Path(png_path).read_bytes(), b'png-bytes')
            agent.x.capture.assert_called_once()
            self.assertEqual(tree.unref.call_count, 4, 'each returned request-owned ref must be released once')
            self.assertEqual(tree.refs, [])
            self.assertEqual(tree.references_used, 0)

    def test_session_identity_cleanup_on_eof(self):
        agent = o.Agent()
        agent.x, agent.a = Mock(), Mock()
        agent.sessions['s'] = dict(selectedObj=42, selectedXid=99)
        agent.close()
        agent.a.unref.assert_called_once_with(42)
        agent.a.release.assert_called_once()
        self.assertEqual(agent.sessions, {})
        self.assertIsNone(agent.x.display)

    def test_output_parents_created_independently(self):
        with tempfile.TemporaryDirectory() as base:
            tree = Path(base) / 'new' / 'tree' / 'a11y.json'
            frame = Path(base) / 'different' / 'frames' / 'frame.png'
            o.write_artifacts(str(tree), str(frame), {'format': 'vlmkit-a11y/1'}, b'png')
            self.assertEqual(json.loads(tree.read_text())['format'], 'vlmkit-a11y/1')
            self.assertEqual(frame.read_bytes(), b'png')

    def test_protocol_envelope_carries_details(self):
        agent = o.Agent()
        agent.dispatch = Mock(side_effect=o.Failure(
            'NATIVE_AX_PARTIAL', 'no bridge', details=dict(x11Windows=1, atspiWindows=0)))
        response = o.handle_request(agent, json.dumps(dict(id=7, protocol=1, method='window.list', params={})))
        self.assertEqual(response['id'], 7)
        self.assertFalse(response['ok'])
        self.assertEqual(response['error']['code'], 'NATIVE_AX_PARTIAL')
        self.assertEqual(response['error']['details'], dict(x11Windows=1, atspiWindows=0))
        # A plain exception must not invent a details field.
        agent.dispatch = Mock(side_effect=RuntimeError('boom'))
        response = o.handle_request(agent, json.dumps(dict(id=8, protocol=1, method='hello', params={})))
        self.assertEqual(response['error']['code'], 'NATIVE_INTERNAL_ERROR')
        self.assertNotIn('details', response['error'])

    def test_ndjson_protocol_stdout(self):
        requests = [dict(id=1, protocol=1, method='hello', params={}),
                    dict(id=2, protocol=2, method='hello', params={}),
                    dict(id=3, protocol=1, method='doctor', params={}),
                    dict(id=4, protocol=1, method='input.click', params={})]
        env = dict(os.environ)
        env.pop('DISPLAY', None)
        env.pop('WAYLAND_DISPLAY', None)
        env.pop('XDG_SESSION_TYPE', None)
        result = subprocess.run([sys.executable, str(Path(o.__file__))], input='\n'.join(map(json.dumps, requests)) + '\n',
                                text=True, capture_output=True, env=env, check=True)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([r['id'] for r in responses], [1, 2, 3, 4])
        self.assertEqual(responses[0]['result']['platform'], 'linux')
        self.assertEqual(responses[1]['error']['code'], 'NATIVE_PROTOCOL_MISMATCH')
        self.assertFalse(responses[2]['result']['screenCapture']['available'])
        self.assertEqual(responses[3]['error']['code'], 'NATIVE_UNSUPPORTED_OPERATION')


class MappingTests(unittest.TestCase):
    """Honest mapping of what a toolkit announces, with no desktop needed."""

    def test_unmapped_roles_are_preserved(self):
        self.assertEqual(o.role_of('push button'), 'button')
        self.assertEqual(o.role_of('page tab'), 'tab')
        # A toolkit role VLMKit has no vocabulary for stays itself, never dropped.
        self.assertEqual(o.role_of('date editor'), 'date editor')
        self.assertEqual(o.role_of(''), 'unknown')

    def test_value_is_a_deterministic_number_or_absent(self):
        self.assertEqual(o.numeric_text(42), '42')
        self.assertEqual(o.numeric_text(4.0), '4')
        self.assertEqual(o.numeric_text(0.25), '0.25')
        self.assertIsNone(o.numeric_text(True))
        self.assertIsNone(o.numeric_text(float('nan')))
        self.assertIsNone(o.numeric_text(float('inf')))
        self.assertIsNone(o.numeric_text('Save'))

    def test_value_reads_the_value_interface_not_a_pointer(self):
        a = object.__new__(o.Atspi)
        a.obj = Mock(return_value=7)
        a.call = Mock(return_value=4.0)
        self.assertEqual(a.value(1, 'slider'), '4')
        # `atspi_accessible_get_value_iface` returns AtspiValue* and takes no
        # GError; the old call passed that pointer through as the value.
        a.obj.assert_called_once_with('accessible_get_value_iface', 1, error=False)
        a.call.assert_called_once_with('value_get_current_value', 7, result=o.C.c_double)
        a.obj = Mock(return_value=None)
        self.assertIsNone(a.value(1, 'progress bar'))
        a.obj = Mock(side_effect=o.Failure('NATIVE_AX_CANNOT_COMPLETE', 'no value iface'))
        self.assertIsNone(a.value(1, 'slider'))

    def test_roles_outside_the_value_set_never_probe(self):
        a = object.__new__(o.Atspi)
        a.obj = Mock()
        a.call = Mock()
        for role in ('entry', 'password text', 'text', 'label', 'static', 'push button'):
            self.assertIsNone(a.value(1, role), role)
        a.obj.assert_not_called()
        a.call.assert_not_called()

    def test_value_read_failure_is_absent_not_fatal(self):
        a = object.__new__(o.Atspi)
        a.obj = Mock(return_value=7)
        a.call = Mock(side_effect=o.Failure('NATIVE_AX_CANNOT_COMPLETE', 'no current value'))
        self.assertIsNone(a.value(1, 'slider'))

    def test_states_are_restricted_to_the_contract(self):
        a = object.__new__(o.Atspi)
        a.obj = Mock(return_value=7)

        def contains(*args, **kwargs):
            index = args[2][0]
            # ENABLED, FOCUSED, SELECTED, SHOWING are all present; checked/expanded are not.
            return 1 if index in (8, 12, 23, 25) else 0
        a.call = Mock(side_effect=contains)
        self.assertEqual(a.states(1), {'focused': True, 'selected': True})
        self.assertFalse(any(k not in o.STATE_KEYS for k in a.states(1)))
        a.call = Mock(return_value=0)  # nothing set: hidden/disabled are the only inference
        self.assertEqual(a.states(1), {'hidden': True, 'disabled': True})
        a.obj = Mock(return_value=None)  # no state set at all: no state is claimed
        self.assertEqual(a.states(1), {})

    def test_partial_association_is_distinguished_from_an_empty_app(self):
        window = dict(pid=10, rect=o.rect(0, 0, 10, 10), xid=5)
        # No AT-SPI window at all: the toolkit has no bridge, not "no app".
        missing = o.association_failure([], [window])
        self.assertEqual(missing.code, 'NATIVE_AX_PARTIAL')
        # AT-SPI sees the window elsewhere: geometry refuses association.
        elsewhere = o.association_failure([dict(pid=10, rect=o.rect(0, 0, 9, 10))], [window])
        self.assertEqual(elsewhere.code, 'NATIVE_AX_PARTIAL')
        self.assertIn('extents', str(elsewhere))
        # A window of another PID is irrelevant to this association.
        self.assertEqual(o.associated_pids([dict(pid=11, rect=window['rect'])], [window]), set())
        # A successful association has no failure to report.
        self.assertIsNone(o.association_failure([dict(pid=10, rect=window['rect'])], [window]))
        # And there is nothing to explain when X11 sees no client either.
        self.assertIsNone(o.association_failure([], []))

    def test_duplicate_identifier_names_both_paths(self):
        fake = TreeAtspi({1: [2, 3]})
        nodes, counts, diagnostics = o.collect(fake, 1, 100, o.rect(0, 0, 1, 1))
        duplicate = [d for d in diagnostics if d['code'] == 'NATIVE_AX_DUPLICATE_IDENTIFIER']
        self.assertEqual(len(duplicate), 2, 'root and both children share the fake identifier')
        self.assertEqual(duplicate[1]['paths'], ['button[0]', 'button[0]>button[1]'])
        self.assertEqual(len(nodes), 3, 'a duplicate identifier never drops a node')

    def test_depth_default_matches_the_public_traversal_bound(self):
        self.assertEqual(o.collect.__defaults__[0], o.DEFAULT_MAX_DEPTH)
        self.assertEqual(o.DEFAULT_MAX_DEPTH, 64)
        self.assertLessEqual(o.DEFAULT_MAX_DEPTH, o.MAX_DEPTH)

    def test_xwayland_extension_is_a_refusal_signal(self):
        x = object.__new__(o.X11)

        class Query:
            def __init__(self, present):
                self.present = present
            def __call__(self, _atom, opcode, _event, _error):
                # ctypes.CArgObject hands back a byref(); write through it as Xlib would.
                opcode._obj.value = 133
                return 1 if self.present else 0

        calls = []
        present = [False]
        def fn(name, *_types):
            calls.append(name)
            if name == 'XInternAtom':
                return lambda *_args: 77
            if name == 'XQueryExtension':
                return Query(present=present[0])
            return lambda *_args: 0  # XSync
        x.fn = fn
        x.errors = []
        self.assertFalse(x.xwayland())
        present[0] = True
        self.assertTrue(x.xwayland())
        self.assertEqual(calls[-2:], ['XQueryExtension', 'XSync'])

if __name__ == '__main__':
    unittest.main()
