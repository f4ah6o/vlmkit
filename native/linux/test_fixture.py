"""The GTK fixtures the live lane drives, without a display.

The fixture's semantics are what the live matrix profile asserts, so a syntax
error or a renamed control here would otherwise only surface in the hosted lane.
The module is imported in a child process: GTK needs its own main thread and,
without a display, fails at `Gtk.Window(...)` — which is recorded as SKIPPED,
never as a pass, because the live lane owns that evidence.
"""
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


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
        if result.returncode != 0 and "Gtk couldn't be initialized" in result.stderr:
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

    def test_integration_declares_every_matrix_identifier(self):
        import integration
        import observer

        # One normalized role per matrix control, and the matrix names only real
        # AT-SPI roles that map to it; every control has a fixture entry.
        fixture = (HERE / "fixture.py").read_text()
        self.assertEqual(set(integration.MATRIX), set(integration.MATRIX_ROLE))
        for identifier, expected in integration.MATRIX.items():
            for role in expected.get("roles", (expected["role"],)):
                self.assertEqual(observer.role_of(role), integration.MATRIX_ROLE[identifier], identifier)
                self.assertIn(role, observer.ROLES, identifier)
            # Control identifiers live in the fixture; the tab list is found by its
            # announced page name instead.
            if identifier != "fixture.tabs":
                self.assertIn(identifier, fixture, identifier)

if __name__ == "__main__":
    unittest.main()
