#!/usr/bin/env python3
"""Run under dbus-run-session + Xvfb. Artifacts contain only this fixture."""
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

HERE = Path(__file__).resolve().parent


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', default='test-results/native/linux')
    args = parser.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    client, app, foreign = Client(), None, None
    report = dict(platform='linux', backend='x11', checks=[])
    try:
        hello = client.request('hello')
        assert hello['platform'] == 'linux' and hello['capabilities']['physicalPointer'] is False
        doctor = client.request('doctor', dict(prompt=False))
        assert doctor['accessibility']['available'] and doctor['screenCapture']['available'], doctor
        app = fixture('--two')
        session = client.request('target.open', dict(target=dict(by='pid', pid=app.pid)))
        sid = session['sessionId']
        for _ in range(30):
            windows = client.request('window.list', dict(sessionId=sid))
            if len(windows) == 2:
                break
            time.sleep(0.1)
        assert len(windows) == 2, windows
        assert windows[0]['title'] == windows[1]['title'], 'Fixture has duplicate titles intentionally'
        selected = min(windows, key=lambda w: w['frameGlobalPoints']['left'])
        client.request('window.select', dict(sessionId=sid, selector=dict(by='window-id', windowId=selected['windowId'])))
        foreign = fixture('--foreign')  # Covers target with bright green pixels.
        params = dict(sessionId=sid, windowId=selected['windowId'], outputTreePath=str(out / 'a11y.json'), outputPngPath=str(out / 'frame.png'))
        result = client.request('snapshot.capture', params)
        tree = json.loads((out / 'a11y.json').read_text())
        assert tree['format'] == 'vlmkit-a11y/1' and tree['platform'] == 'linux'
        assert result['frameKind'] == 'client-window' and result['identity']['pid'] == app.pid
        assert result['viewport'] == dict(width=360, height=260)
        assert result['scale'] == tree['scale'] == 1
        assert result['counts']['truncated'] == 0, result
        assert result['counts']['attributeErrors'] == 0, result
        save = next(n for n in tree['nodes'] if n.get('name') == 'Save')
        assert save['role'] == 'button', save
        assert save.get('identifier') == 'fixture.save', save
        color = next(n for n in tree['nodes'] if n.get('identifier') == 'fixture.color')
        width, height, pixel = read_rgb_png(out / 'frame.png')
        r = color['rect']
        point = (int(r['left'] + r['width'] / 2), int(r['top'] + r['height'] / 2))
        assert pixel(*point) == (255, 0, 0), ('Selected red client pixels must survive green foreign occlusion', pixel(*point))
        report['checks'].extend(['duplicate-title same-PID windows', 'stable toolkit identifier', 'client-frame geometry', 'semantic-rect pixel alignment', 'foreign occluder excluded'])
        truncated = client.request('snapshot.capture', dict(params, maxNodes=1, outputTreePath=str(out / 'truncated.json'), outputPngPath=str(out / 'truncated.png')))
        assert truncated['counts']['nodes'] == 1 and truncated['counts']['truncated'] > 0
        report['checks'].append('bounded traversal reports truncation')
        client.request('snapshot.capture', dict(params, windowId='window[x11:0]'), error='NATIVE_WINDOW_NOT_SELECTED')
        client.request('input.click', {}, error='NATIVE_UNSUPPORTED_OPERATION')
        client.request('session.close', dict(sessionId=sid, terminateIfLaunched=True), error='NATIVE_UNSUPPORTED_OPERATION')
        client.request('session.close', dict(sessionId=sid))
        assert app.poll() is None
        report['checks'].extend(['capture selected-window binding', 'physical input denied', 'close detaches only'])
        report.update(passed=True, hello=hello, doctor=doctor, capture=result)
        (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    except Exception as error:
        report.update(passed=False, error=str(error), traceback=traceback.format_exc(), protocol=client.history)
        (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        raise
    finally:
        for p in (foreign, app):
            if p and p.poll() is None:
                p.terminate()
                p.wait(timeout=5)
        client.close()


if __name__ == '__main__':
    main()
