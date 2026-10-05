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
from unittest.mock import patch
import zlib

import observer as o


class ObserverTests(unittest.TestCase):
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

    def test_traversal_bounds_identifiers_negative_origin(self):
        class Fake:
            def pid(self, obj): return 100 if obj != 5 else 101
            def text(self, name, obj):
                return {'accessible_get_role_name': 'push button', 'accessible_get_name': '', 'accessible_get_accessible_id': 'real-id'}[name]
            def bounds(self, obj): return o.rect(-90, 25, 20, 10)
            def states(self, obj): return {}
            def obj(self, *args, **kwargs): return None
            def children(self, obj): return iter([(0, 2), (1, 3), (2, 5)]) if obj == 1 else iter([])
        nodes, counts, diagnostics = o.collect(Fake(), 1, 100, o.rect(-100, 20, 100, 100))
        self.assertEqual(nodes[0]['rect'], o.rect(10, 5, 20, 10))
        self.assertEqual(nodes[0]['identifier'], 'real-id')
        self.assertNotIn('actions', nodes[0])
        self.assertEqual(len({n['path'] for n in nodes}), 3)
        self.assertEqual(counts['truncated'], 1)
        self.assertTrue(any(d['code'] == 'NATIVE_AX_DUPLICATE_IDENTIFIER' for d in diagnostics))
        _, counts, _ = o.collect(Fake(), 1, 100, o.rect(0, 0, 1, 1), max_nodes=1)
        self.assertEqual(counts['nodes'], 1)
        self.assertEqual(counts['truncated'], 3)
        _, counts, _ = o.collect(Fake(), 1, 100, o.rect(0, 0, 1, 1), max_depth=0)
        self.assertEqual(counts['nodes'], 1)
        self.assertEqual(counts['truncated'], 3)

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
