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
        exact = TreeAtspi({1: [2]})
        _, counts, _ = o.collect(exact, 1, 100, o.rect(0, 0, 1, 1), max_visited=2)
        self.assertEqual(counts['nodes'], 2)
        self.assertEqual(counts['truncated'], 0)
        self.assertEqual(exact.child_fetches, [(1, 0)])

        off_by_one = TreeAtspi({1: [2]})
        _, counts, diagnostics = o.collect(off_by_one, 1, 100, o.rect(0, 0, 1, 1), max_visited=1)
        self.assertEqual(counts['nodes'], 1)
        self.assertEqual(counts['truncated'], 1)
        self.assertEqual(off_by_one.child_fetches, [])
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
        from unittest.mock import Mock
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


if __name__ == '__main__':
    unittest.main()
