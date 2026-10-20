"""The GTK fixtures the live lane drives, without a display.

The fixture's semantics are what the live matrix profile asserts, so a syntax
error or a renamed control here would otherwise only surface in the hosted lane.
The module is imported in a child process without entering its main loop (the
fixture separates `build_windows()` from `run()`), so a display host checks that
both fixtures build; without a display, `Gtk.Window(...)` fails and the test is
recorded as SKIPPED, never as a pass, because the live lane owns that evidence.
"""
import subprocess
import sys
import unittest
from unittest.mock import patch
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
# `unittest discover -s native/linux` puts this directory on sys.path implicitly;
# running a single module from the repository root does not.
sys.path.insert(0, str(HERE))


def _gtk_unavailable(stderr):
    return any(message in stderr for message in (
        "Gtk couldn't be initialized",
        "cannot open display",
        "Could not connect to display",
        "Could not connect: Connection refused",
    ))


def import_fixture(*args):
    """Import fixture.py in a child process and report how many windows it built.

    A display can accept the connection and still never map the window (a stale
    socket, an X server that is not accepting clients); a timeout is that case
    too, so it is reported as a sentinel rather than raised.
    """
    script = (
        "import runpy, sys\n"
        'sys.argv = ["fixture.py", *sys.argv[1:]]\n'
        f'ns = runpy.run_path({str(HERE / "fixture.py")!r}, run_name="fixture_import")\n'
        'print(len(ns["windows"]))\n'
    )
    return subprocess.run([sys.executable, "-c", script, *args], capture_output=True, text=True, timeout=30)


class FixtureTests(unittest.TestCase):
    def assert_builds(self, *args):
        try:
            import gi  # noqa: F401
        except ImportError:
            self.skipTest("PyGObject is not installed; the fixture only runs on the live lane")
        try:
            result = import_fixture(*args)
        except subprocess.TimeoutExpired:
            # A display that accepts the connection but never maps the window is the
            # same absence: the live lane is the only place this becomes evidence.
            self.skipTest("no usable display; the live lane owns the fixture evidence")
        if result.returncode != 0 and _gtk_unavailable(result.stderr):
            self.skipTest("GTK needs a display to build a window; the live lane owns that")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "1")

    def test_base_fixture_builds_one_window(self):
        self.assert_builds()

    def test_matrix_fixture_builds_one_window(self):
        self.assert_builds("--matrix")

    def test_sources_compile(self):
        for name in ("fixture.py", "integration.py", "observer.py"):
            compile((HERE / name).read_text(), name, "exec")

    def test_partial_profile_requires_xlib(self):
        import integration
        import builtins
        original_import = builtins.__import__
        def without_xlib(name, *args, **kwargs):
            if name == 'Xlib.display':
                raise ImportError('missing python3-xlib')
            return original_import(name, *args, **kwargs)
        with tempfile.TemporaryDirectory() as directory, patch('builtins.__import__', side_effect=without_xlib):
            with self.assertRaisesRegex(ImportError, 'missing python3-xlib'):
                integration.partial_association(Path(directory))

    def test_integration_declares_every_matrix_identifier(self):
        import integration
        import observer

        # One normalized role per matrix control, and the matrix names only real
        # AT-SPI roles that map to it; every control has a fixture entry.
        fixture = (HERE / "fixture.py").read_text()
        self.assertEqual(set(integration.MATRIX), set(integration.MATRIX_ROLE))
        for identifier in integration.MATRIX:
            for role in integration.accepted_roles(identifier):
                self.assertIn(role, observer.ROLES, identifier)
                # The mapping is checked for every accepted name, including the
                # `text` GTK3 announces for a labelled entry; a lost mapping must
                # fail here rather than agree with whatever the observer produced.
                self.assertIn(observer.role_of(role), integration.MATRIX_ROLE[identifier], identifier)
            self.assertIn(identifier, fixture, identifier)

if __name__ == "__main__":
    unittest.main()
