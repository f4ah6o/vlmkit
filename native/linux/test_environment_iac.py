"""Static and safe CLI checks for the pinned Linux fixture environment."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy


LINUX = Path(__file__).resolve().parent
ENV = LINUX / "environment"
LOCK = ENV / "lock.json"
SCRIPTS = [ENV / name for name in ("common.sh", "bootstrap.sh", "doctor.sh", "run-fixture.sh")]


class LinuxEnvironmentIaCTest(unittest.TestCase):
    def test_lock_has_exact_pinned_overlay_and_signed_index_provenance(self) -> None:
        lock = json.loads(LOCK.read_text(encoding="utf-8"))
        self.assertEqual(lock["platform"], {
            "os": "linux",
            "distribution": "Debian GNU/Linux 13",
            "codename": "trixie",
            "architecture": "amd64",
        })
        self.assertEqual(lock["pythonRuntime"], {
            "version": "3.13",
            "soabi": "cpython-313-x86_64-linux-gnu",
            "moduleDirectory": "usr/lib/python3/dist-packages",
        })
        provenance = lock["provenance"]
        for key in ("inReleaseSha256", "archiveKeyringSha256", "packagesIndexSha256", "packagesIndexCompressedSha256"):
            self.assertRegex(provenance[key], r"^[0-9a-f]{64}$")
        self.assertGreater(provenance["inReleaseSize"], 0)
        self.assertGreater(provenance["archiveKeyringSize"], 0)
        self.assertGreater(provenance["packagesIndexSize"], 0)
        self.assertGreater(provenance["packagesIndexCompressedSize"], 0)
        self.assertEqual(provenance["repository"], "https://deb.debian.org/debian/")
        self.assertEqual(provenance["packagesIndexCompressedPath"], "dists/trixie/main/binary-amd64/Packages.xz")
        self.assertEqual(len(provenance["verifiedSignerPrimaryFingerprints"]), 3)
        for fingerprint in provenance["verifiedSignerPrimaryFingerprints"]:
            self.assertRegex(fingerprint, r"^[A-F0-9]{40}$")

        packages = lock["packages"]
        self.assertEqual([p["name"] for p in packages], [
            "xvfb", "xserver-common", "xauth", "x11-xkb-utils", "xcompmgr",
            "python3-gi", "python3-cairo", "python3-gi-cairo",
        ])
        by_name = {p["name"]: p for p in packages}
        self.assertEqual(by_name["python3-gi"]["version"], "3.50.0-4+b1")
        self.assertEqual(by_name["python3-cairo"]["version"], "1.27.0-2")
        self.assertEqual(by_name["python3-gi-cairo"]["version"], "3.50.0-4+b1")
        for package in packages:
            self.assertRegex(package["sha256"], r"^[0-9a-f]{64}$")
            self.assertGreater(package["size"], 0)
            self.assertTrue(package["filename"].startswith("pool/"))

    def test_bundled_official_metadata_verifies_offline(self) -> None:
        result = subprocess.run(
            [sys.executable, str(ENV / "verify_provenance.py"), str(LOCK)],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("signed Packages index digest", result.stdout)
        tampered_lock = json.loads(LOCK.read_text(encoding="utf-8"))
        tampered_lock["provenance"]["packagesIndexCompressedSha256"] = "0" * 64
        with tempfile.TemporaryDirectory() as temp:
            lock_path = Path(temp) / "tampered-lock.json"
            lock_path.write_text(json.dumps(tampered_lock), encoding="utf-8")
            invalid = subprocess.run(
                [sys.executable, str(ENV / "verify_provenance.py"), str(lock_path)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(invalid.returncode, 0)
            self.assertIn("compressed Packages index", invalid.stderr)

    @staticmethod
    def _packages_index_content(lock: dict) -> bytes:
        stanzas = []
        for package in lock["packages"]:
            stanzas.append(
                "\n".join(
                    (
                        f"Package: {package['name']}",
                        f"Version: {package['version']}",
                        f"Architecture: {package['architecture']}",
                        f"Filename: {package['filename']}",
                        f"Size: {package['size']}",
                        f"SHA256: {package['sha256']}",
                        "Description: fixture metadata for offline bootstrap tests",
                        "",
                    )
                )
            )
        return ("\n".join(stanzas) + "\n").encode("utf-8")

    def test_locked_package_tuples_must_match_packages_index_records(self) -> None:
        lock = json.loads(LOCK.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as temp:
            index_file = Path(temp) / "Packages"
            index_file.write_bytes(self._packages_index_content(lock))
            valid = subprocess.run(
                [sys.executable, str(ENV / "verify_packages.py"), str(LOCK), str(index_file)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(valid.returncode, 0, valid.stdout + valid.stderr)

            lock["packages"][0]["sha256"] = "0" * 64
            tampered_lock = Path(temp) / "tampered-lock.json"
            tampered_lock.write_text(json.dumps(lock), encoding="utf-8")
            invalid = subprocess.run(
                [sys.executable, str(ENV / "verify_packages.py"), str(tampered_lock), str(index_file)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(invalid.returncode, 0)
            self.assertIn("SHA256 differs", invalid.stderr)

    def test_scripts_are_syntactically_valid_and_have_safe_help(self) -> None:
        for script in SCRIPTS:
            syntax = subprocess.run(["bash", "-n", str(script)], text=True, capture_output=True)
            self.assertEqual(syntax.returncode, 0, syntax.stderr)
        for script in (ENV / "verify_provenance.py", ENV / "verify_packages.py", ENV / "overlay_manifest.py"):
            syntax = subprocess.run([sys.executable, "-m", "py_compile", str(script)], text=True, capture_output=True)
            self.assertEqual(syntax.returncode, 0, syntax.stderr)
        for script in (ENV / "bootstrap.sh", ENV / "doctor.sh", ENV / "run-fixture.sh"):
            result = subprocess.run([str(script), "--help"], text=True, capture_output=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_bootstrap_is_unprivileged_and_does_not_manage_host_packages(self) -> None:
        source = (ENV / "bootstrap.sh").read_text(encoding="utf-8")
        self.assertIn("dpkg-deb --extract", source)
        self.assertIn("sha256sum", source)
        self.assertIn("curl --fail --location", source)
        self.assertIn("/by-hash/SHA256/", source)
        self.assertIn("verify_packages.py", source)
        self.assertNotRegex(source, r"\bsudo\b|\bapt(-get)?\s+(install|update|upgrade)\b|\bdpkg\s+-i\b|\bsystemctl\b")
        doctor = (ENV / "doctor.sh").read_text(encoding="utf-8")
        self.assertIn("/usr/bin/xkbcomp", doctor)

    def test_doctor_default_does_not_execute_a_dbus_probe(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            prefix = temp_path / "prefix"
            overlay_bin = prefix / "overlay" / "usr" / "bin"
            overlay_bin.mkdir(parents=True)
            lock_hash = hashlib.sha256(LOCK.read_bytes()).hexdigest()
            (prefix / "overlay" / ".vlmkit-managed").write_text(lock_hash + "\n", encoding="utf-8")
            for binary in ("Xvfb", "xvfb-run", "xauth", "xkbcomp", "setxkbmap", "xcompmgr"):
                executable = overlay_bin / binary
                executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
                executable.chmod(0o755)
            subprocess.run([sys.executable, str(ENV / "overlay_manifest.py"), "build", str(prefix / "overlay")], check=True)

            stub_bin = temp_path / "bin"
            stub_bin.mkdir()
            marker = temp_path / "dbus-was-run"
            stub = stub_bin / "dbus-run-session"
            stub.write_text("#!/bin/sh\nprintf called > \"$DBUS_PROBE_MARKER\"\n", encoding="utf-8")
            stub.chmod(0o755)
            env = dict(os.environ)
            env["VLMKIT_LINUX_PREFIX"] = str(prefix)
            env["VLMKIT_LINUX_PYTHON"] = "/usr/bin/python3"
            env["DBUS_PROBE_MARKER"] = str(marker)
            env["PATH"] = f"{stub_bin}:{env.get('PATH', '/usr/bin:/bin')}"
            result = subprocess.run([str(ENV / "doctor.sh")], env=env, text=True, capture_output=True, check=False)
            self.assertIn("D-Bus session not probed", result.stdout)
            self.assertFalse(marker.exists(), "default doctor must not start/connect to D-Bus")

    def test_doctor_typelib_check_does_not_import_or_initialize_gtk(self) -> None:
        source = (ENV / "doctor.sh").read_text(encoding="utf-8")
        self.assertIn('gi.require_foreign("cairo")', source)
        self.assertLess(source.index('gi.require_foreign("cairo")'), source.index('repository.require("Gtk", "3.0", 0)'))
        self.assertIn('repository.require("Gtk", "3.0", 0)', source)
        self.assertIn('repository.require("Atk", "1.0", 0)', source)
        self.assertIn("libatk-bridge-2.0.so.0", source)
        self.assertNotIn("gtk-3.0/modules/libatk-bridge.so", source)
        self.assertNotIn("from gi.repository import Atk, Gtk", source)
        self.assertNotIn("Gtk.init", source)

    def test_doctor_blocks_missing_cairo_foreign_converter_with_mock_python(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            mock_python = temp_path / "python-with-mocked-cairo.py"
            source_log = temp_path / "python-probes.log"
            mock_python.write_text(
                "#!/bin/sh\n"
                "body=$(cat)\n"
                "printf 'PYTHONPATH=%s\\nPYTHONDONTWRITEBYTECODE=%s\\n' \"${PYTHONPATH:-}\" \"${PYTHONDONTWRITEBYTECODE:-}\" >> \"$MOCK_PYTHON_PROBE_LOG\"\n"
                "printf '%s\\n---\\n' \"$body\" >> \"$MOCK_PYTHON_PROBE_LOG\"\n"
                "case \"$body\" in\n"
                "  *'gi.require_foreign(\"cairo\")'*) [ \"${MOCK_CAIRO_AVAILABLE:-0}\" = 1 ] ;;\n"
                "  *'repository.require(\"Gtk\", \"3.0\", 0)'*) exit 0 ;;\n"
                "  *) exit 1 ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            mock_python.chmod(0o755)
            env = dict(os.environ)
            env["VLMKIT_LINUX_PREFIX"] = str(temp_path / "isolated prefix")
            env["VLMKIT_LINUX_PYTHON"] = str(mock_python)
            env["MOCK_PYTHON_PROBE_LOG"] = str(source_log)

            result = subprocess.run([str(ENV / "doctor.sh")], env=env, text=True, capture_output=True, check=False)
            available_env = dict(env)
            available_env["MOCK_CAIRO_AVAILABLE"] = "1"
            available = subprocess.run([str(ENV / "doctor.sh")], env=available_env, text=True, capture_output=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotEqual(available.returncode, 0, "the intentionally incomplete host should remain blocked by other prerequisites")
            self.assertIn("BLOCKED  Python overlay Cairo converter", result.stdout)
            self.assertIn("PASS  Python overlay verified", available.stdout)
            probes = source_log.read_text(encoding="utf-8")
            self.assertIn('gi.require_foreign("cairo")', probes)
            self.assertIn('repository.require("Gtk", "3.0", 0)', probes)
            self.assertIn(f"PYTHONPATH={temp_path / 'isolated prefix' / 'overlay' / 'usr' / 'lib' / 'python3' / 'dist-packages'}", probes)
            self.assertIn("PYTHONDONTWRITEBYTECODE=1", probes)
            self.assertNotIn("Gtk.init", probes)
            self.assertIn("D-Bus session not probed", result.stdout)

            def issue_count(proc: subprocess.CompletedProcess[str]) -> int:
                match = re.search(r"Preflight found (\d+) issue", proc.stdout + proc.stderr)
                self.assertIsNotNone(match, proc.stdout + proc.stderr)
                return int(match.group(1))

            self.assertEqual(issue_count(result), issue_count(available) + 1, "missing Cairo converter must increment the blocked prerequisite count")

    def test_runner_stops_after_doctor_blocks_before_dbus_or_xvfb(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            repo = temp_path / "repo"
            env_dir = repo / "native" / "linux" / "environment"
            env_dir.mkdir(parents=True)
            shutil.copy2(ENV / "common.sh", env_dir / "common.sh")
            shutil.copy2(ENV / "run-fixture.sh", env_dir / "run-fixture.sh")
            shutil.copy2(LOCK, env_dir / "lock.json")
            doctor = env_dir / "doctor.sh"
            doctor.write_text(
                "#!/bin/sh\n"
                "echo 'BLOCKED  Python overlay Cairo converter unavailable'\n"
                "exit 1\n",
                encoding="utf-8",
            )
            doctor.chmod(0o755)

            stub_bin = temp_path / "stub-bin"
            stub_bin.mkdir()
            launch_marker = temp_path / "display-launch-attempted"
            for name in ("dbus-run-session", "xvfb-run"):
                stub = stub_bin / name
                stub.write_text("#!/bin/sh\nprintf called > \"$FIXTURE_LAUNCH_MARKER\"\nexit 99\n", encoding="utf-8")
                stub.chmod(0o755)

            evidence_dir = temp_path / "fixture evidence"
            env = dict(os.environ)
            env["VLMKIT_LINUX_PREFIX"] = str(temp_path / "private prefix")
            env["VLMKIT_LINUX_EVIDENCE_DIR"] = str(evidence_dir)
            env["VLMKIT_LINUX_PYTHON"] = "/usr/bin/python3"
            env["FIXTURE_LAUNCH_MARKER"] = str(launch_marker)
            env["PATH"] = f"{stub_bin}:{env.get('PATH', '/usr/bin:/bin')}"

            result = subprocess.run([str(env_dir / "run-fixture.sh")], env=env, text=True, capture_output=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("BLOCKED  Python overlay Cairo converter unavailable", result.stdout)
            self.assertFalse(launch_marker.exists(), "D-Bus and Xvfb launchers must not run after a failed doctor")
            self.assertFalse(evidence_dir.exists(), "runner must stop before creating fixture evidence when doctor fails")

    def test_runner_isolated_and_records_exact_source_hashes(self) -> None:
        source = (ENV / "run-fixture.sh").read_text(encoding="utf-8")
        self.assertIn("timeout --signal=TERM --kill-after=10s", source)
        self.assertIn("PYTHONDONTWRITEBYTECODE=1", source)
        self.assertIn("dbus-run-session -- xvfb-run", source)
        self.assertIn("native/linux/integration.py", source)
        self.assertIn("XDG_SESSION_TYPE=x11", source)
        self.assertIn("unset WAYLAND_DISPLAY WAYLAND_SOCKET AT_SPI_BUS_ADDRESS AT_SPI_DISPLAY", source)
        for name in (
            "native/linux/observer.py",
            "native/linux/fixture.py",
            "native/linux/integration.py",
            "native/linux/with-compositor.sh",
            "native/linux/environment/lock.json",
            "native/linux/environment/metadata/trixie.InRelease",
            "native/linux/environment/metadata/debian-archive-keyring.pgp",
            "native/linux/environment/common.sh",
            "native/linux/environment/verify_provenance.py",
            "native/linux/environment/verify_packages.py",
            "native/linux/environment/overlay_manifest.py",
            "native/linux/environment/run-fixture.sh",
        ):
            self.assertIn(name, source)
        self.assertNotRegex(source, r"\bDISPLAY=:[0-9]+\b|xhost\s+\+|xrandr\s+--output")
        integration = (LINUX / "integration.py").read_text(encoding="utf-8")
        self.assertIn("sys.executable", integration)
        self.assertNotIn("'/usr/bin/python3'", integration)

    def _fake_bootstrap(self, temp_path: Path, prefix: Path, *, lock: dict | None = None) -> tuple[dict, dict[str, str]]:
        """Set up offline fake packages/index and inert system-tool shims."""
        lock_data = deepcopy(lock or json.loads(LOCK.read_text(encoding="utf-8")))
        lock_path = temp_path / "fixture-lock.json"
        for package in lock_data["packages"]:
            payload = f"offline-test-package:{package['name']}\n".encode()
            package["size"] = len(payload)
            package["sha256"] = hashlib.sha256(payload).hexdigest()
        lock_path.write_text(json.dumps(lock_data, indent=2) + "\n", encoding="utf-8")

        downloads = prefix / "downloads"
        downloads.mkdir(parents=True)
        for package in lock_data["packages"]:
            payload = f"offline-test-package:{package['name']}\n".encode()
            (downloads / Path(package["filename"]).name).write_bytes(payload)
        metadata_dir = prefix / "metadata"
        metadata_dir.mkdir()
        provenance = lock_data["provenance"]
        compressed_index = metadata_dir / f"{provenance['packagesIndexCompressedSha256']}.Packages.xz"
        compressed_index.write_bytes(b"mock compressed index; xz is stubbed")
        fixture_index = temp_path / "Packages.fixture"
        fixture_index.write_bytes(self._packages_index_content(lock_data))

        fake_bin = temp_path / "mock-bin"
        fake_bin.mkdir()
        common_stub = "#!/usr/bin/env python3\nimport hashlib, json, os, pathlib, sys\n"

        sha_stub = fake_bin / "sha256sum"
        sha_stub.write_text(
            common_stub
            + "args = [a for a in sys.argv[1:] if a != '--']\n"
            + "path = pathlib.Path(args[-1])\n"
            + "lock_path = pathlib.Path(os.environ['VLMKIT_LINUX_LOCK_FILE'])\n"
            + "if path == lock_path: os.execv('/usr/bin/sha256sum', ['/usr/bin/sha256sum', *sys.argv[1:]])\n"
            + "lock = json.loads(lock_path.read_text())\n"
            + "prov = lock['provenance']\n"
            + "if path.name == prov['packagesIndexCompressedSha256'] + '.Packages.xz': value = prov['packagesIndexCompressedSha256']\n"
            + "elif path.name.startswith('Packages.'): value = prov['packagesIndexSha256']\n"
            + "else:\n"
            + "    package = next((p for p in lock['packages'] if pathlib.Path(p['filename']).name == path.name), None)\n"
            + "    value = hashlib.sha256(path.read_bytes()).hexdigest() if package else None\n"
            + "if value is None: os.execv('/usr/bin/sha256sum', ['/usr/bin/sha256sum', *sys.argv[1:]])\n"
            + "print(value + '  ' + str(path))\n",
            encoding="utf-8",
        )
        sha_stub.chmod(0o755)

        stat_stub = fake_bin / "stat"
        stat_stub.write_text(
            common_stub
            + "path = pathlib.Path(sys.argv[-1])\n"
            + "lock = json.loads(pathlib.Path(os.environ['VLMKIT_LINUX_LOCK_FILE']).read_text())\n"
            + "prov = lock['provenance']\n"
            + "if path.name == prov['packagesIndexCompressedSha256'] + '.Packages.xz': value = prov['packagesIndexCompressedSize']\n"
            + "elif path.name.startswith('Packages.'): value = prov['packagesIndexSize']\n"
            + "else: value = path.stat().st_size\n"
            + "print(value)\n",
            encoding="utf-8",
        )
        stat_stub.chmod(0o755)

        dpkg_stub = fake_bin / "dpkg-deb"
        dpkg_stub.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys\n"
            "args = sys.argv[1:]\n"
            "lock = json.loads(pathlib.Path(os.environ['VLMKIT_LINUX_LOCK_FILE']).read_text())\n"
            "if args and args[0].startswith('--showformat='):\n"
            "    archive = pathlib.Path(args[-1])\n"
            "    package = next(p for p in lock['packages'] if pathlib.Path(p['filename']).name == archive.name)\n"
            "    print(package['name'] + '\\t' + package['version'] + '\\t' + package['architecture'])\n"
            "elif len(args) == 3 and args[0] == '--extract':\n"
            "    archive, dest = pathlib.Path(args[1]), pathlib.Path(args[2])\n"
            "    package = next(p for p in lock['packages'] if pathlib.Path(p['filename']).name == archive.name)\n"
            "    log = pathlib.Path(os.environ['FAKE_DPKG_LOG'])\n"
            "    with log.open('a') as f: f.write(package['name'] + '\\n')\n"
            "    if os.environ.get('FAKE_EXTRACT_FAIL') == package['name']: raise SystemExit(17)\n"
            "    (dest / ('fake-' + package['name'])).write_text('mock extraction only\\n')\n"
            "    bindir = dest / 'usr' / 'bin'; bindir.mkdir(parents=True, exist_ok=True)\n"
            "    for name in ['Xvfb', 'xvfb-run', 'xauth', 'xkbcomp', 'setxkbmap', 'xcompmgr']:\n"
            "        path = bindir / name; path.write_text('#!/bin/sh\\nexit 0\\n'); path.chmod(0o755)\n"
            "else: raise SystemExit('unexpected dpkg-deb arguments: ' + repr(args))\n",
            encoding="utf-8",
        )
        dpkg_stub.chmod(0o755)
        curl_stub = fake_bin / "curl"
        curl_stub.write_text(
            "#!/usr/bin/env python3\n"
            "import os, pathlib, sys\n"
            "with pathlib.Path(os.environ['FAKE_CURL_LOG']).open('a') as f: f.write('called\\n')\n"
            "args = sys.argv[1:]\n"
            "if '--output' in args: pathlib.Path(args[args.index('--output') + 1]).write_bytes(b'partial-download')\n"
            "raise SystemExit(22)\n",
            encoding="utf-8",
        )
        curl_stub.chmod(0o755)
        xz_stub = fake_bin / "xz"
        xz_stub.write_text(
            "#!/usr/bin/env python3\n"
            "import os, pathlib, sys\n"
            "assert sys.argv[1:3] == ['--decompress', '--stdout']\n"
            "sys.stdout.buffer.write(pathlib.Path(os.environ['FAKE_PACKAGES_INDEX']).read_bytes())\n",
            encoding="utf-8",
        )
        xz_stub.chmod(0o755)

        env = dict(os.environ)
        env["VLMKIT_LINUX_PREFIX"] = str(prefix)
        env["VLMKIT_LINUX_LOCK_FILE"] = str(lock_path)
        env["FAKE_PACKAGES_INDEX"] = str(fixture_index)
        env["FAKE_DPKG_LOG"] = str(prefix / "fake-dpkg.log")
        env["FAKE_CURL_LOG"] = str(prefix / "fake-curl.log")
        env["PATH"] = f"{fake_bin}:{env.get('PATH', '/usr/bin:/bin')}"
        return lock_data, env

    def test_offline_cached_archives_custom_prefix_idempotence_and_no_host_writes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            prefix = temp_path / "custom root with spaces" / "user overlay"
            lock, env = self._fake_bootstrap(temp_path, prefix)
            other_files_before = sorted(str(p.relative_to(temp_path)) for p in temp_path.rglob("*") if not p.is_relative_to(prefix))

            first = subprocess.run([str(ENV / "bootstrap.sh")], env=env, text=True, capture_output=True, check=False)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            self.assertIn("Installed the pinned X11 fixture overlay", first.stdout)
            self.assertEqual((prefix / "fake-dpkg.log").read_text().splitlines(), [p["name"] for p in lock["packages"]])
            self.assertFalse((prefix / "fake-curl.log").exists(), "valid offline cache must avoid curl")

            second = subprocess.run([str(ENV / "bootstrap.sh")], env=env, text=True, capture_output=True, check=False)
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertIn("no extraction needed", second.stdout)
            self.assertEqual((prefix / "fake-dpkg.log").read_text().splitlines(), [p["name"] for p in lock["packages"]])
            self.assertFalse((prefix / "fake-curl.log").exists())
            other_files_after = sorted(str(p.relative_to(temp_path)) for p in temp_path.rglob("*") if not p.is_relative_to(prefix))
            self.assertEqual(other_files_before, other_files_after, "bootstrap must write only beneath the configured prefix")

    def test_tampered_cached_archive_is_not_extracted_or_silently_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            prefix = temp_path / "prefix"
            lock, env = self._fake_bootstrap(temp_path, prefix)
            first = subprocess.run([str(ENV / "bootstrap.sh")], env=env, text=True, capture_output=True, check=False)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            marker = prefix / "overlay" / ".vlmkit-managed"
            marker_before = marker.read_text()
            package = lock["packages"][0]
            archive = prefix / "downloads" / Path(package["filename"]).name
            archive.write_bytes(b"tampered-cache!\n")

            retry = subprocess.run([str(ENV / "bootstrap.sh")], env=env, text=True, capture_output=True, check=False)
            self.assertNotEqual(retry.returncode, 0)
            self.assertTrue((prefix / "fake-curl.log").exists(), "tampered cache must not be trusted as an offline hit")
            self.assertEqual(list((prefix / "downloads").glob("*.tmp.*")), [], "failed partial download must be removed")
            self.assertEqual(marker.read_text(), marker_before, "failed redownload must leave the existing overlay intact")
            self.assertEqual((prefix / "fake-dpkg.log").read_text().splitlines(), [p["name"] for p in lock["packages"]])

    def test_lock_update_retains_the_previous_managed_overlay(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            prefix = temp_path / "prefix"
            lock, env = self._fake_bootstrap(temp_path, prefix)
            first = subprocess.run([str(ENV / "bootstrap.sh")], env=env, text=True, capture_output=True, check=False)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            previous_marker = (prefix / "overlay" / ".vlmkit-managed").read_text()

            lock_path = Path(env["VLMKIT_LINUX_LOCK_FILE"])
            updated_lock = json.loads(lock_path.read_text(encoding="utf-8"))
            updated_lock["provenance"]["testRevision"] = 2
            lock_path.write_text(json.dumps(updated_lock, indent=2) + "\n", encoding="utf-8")
            second = subprocess.run([str(ENV / "bootstrap.sh")], env=env, text=True, capture_output=True, check=False)
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            self.assertIn("Previous managed overlay retained", second.stdout)

            backups = list(prefix.glob(".overlay-previous.*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual((backups[0] / ".vlmkit-managed").read_text(), previous_marker)
            self.assertNotEqual((prefix / "overlay" / ".vlmkit-managed").read_text(), previous_marker)
            self.assertTrue((backups[0] / "fake-xvfb").exists())

    def test_corrupt_overlay_is_repaired_and_previous_state_is_retained(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            prefix = temp_path / "prefix"
            _, env = self._fake_bootstrap(temp_path, prefix)
            first = subprocess.run([str(ENV / "bootstrap.sh")], env=env, text=True, capture_output=True, check=False)
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            previous_marker = (prefix / "overlay" / ".vlmkit-managed").read_text()
            (prefix / "overlay" / "usr" / "bin" / "Xvfb").unlink()

            repaired = subprocess.run([str(ENV / "bootstrap.sh")], env=env, text=True, capture_output=True, check=False)
            self.assertEqual(repaired.returncode, 0, repaired.stdout + repaired.stderr)
            self.assertIn("incomplete or altered", repaired.stdout)
            self.assertTrue((prefix / "overlay" / "usr" / "bin" / "Xvfb").is_file())
            backups = list(prefix.glob(".overlay-previous.*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual((backups[0] / ".vlmkit-managed").read_text(), previous_marker)
            self.assertFalse((backups[0] / "usr" / "bin" / "Xvfb").exists())

    def test_path_traversal_in_lock_is_rejected_before_download_or_extract(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            lock_data = deepcopy(json.loads(LOCK.read_text(encoding="utf-8")))
            lock_data["packages"][0]["filename"] = "pool/../../tmp/vlmkit-path-traversal.deb"
            lock_path = temp_path / "malicious-lock.json"
            lock_path.write_text(json.dumps(lock_data), encoding="utf-8")
            prefix = temp_path / "prefix with spaces"
            fake_bin = temp_path / "empty-bin"
            fake_bin.mkdir()
            curl_log = prefix / "fake-curl.log"
            env = dict(os.environ)
            env["VLMKIT_LINUX_PREFIX"] = str(prefix)
            env["VLMKIT_LINUX_LOCK_FILE"] = str(lock_path)
            env["FAKE_DPKG_LOG"] = str(prefix / "fake-dpkg.log")
            env["FAKE_CURL_LOG"] = str(curl_log)
            env["PATH"] = f"{fake_bin}:{env.get('PATH', '/usr/bin:/bin')}"
            result = subprocess.run([str(ENV / "bootstrap.sh")], env=env, text=True, capture_output=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unsafe package path", result.stderr)
            self.assertFalse(curl_log.exists())
            self.assertFalse((prefix / "overlay").exists())
            self.assertFalse((temp_path / "tmp" / "vlmkit-path-traversal.deb").exists())

    def test_system_prefix_is_refused_before_any_write(self) -> None:
        env = dict(os.environ)
        env["VLMKIT_LINUX_PREFIX"] = "/"
        result = subprocess.run([str(ENV / "bootstrap.sh"), "--help"], env=env, text=True, capture_output=True, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Refusing a system-directory prefix", result.stderr)

    def test_symlink_cache_children_are_rejected_without_writing_through_them(self) -> None:
        for child in ("downloads", "metadata"):
            with self.subTest(child=child), tempfile.TemporaryDirectory() as temp:
                temp_path = Path(temp)
                prefix = temp_path / "prefix"
                _, env = self._fake_bootstrap(temp_path, prefix)
                cache_child = prefix / child
                saved = prefix / f"{child}.saved"
                cache_child.rename(saved)
                outside = temp_path / "outside"
                outside.mkdir()
                sentinel = outside / "keep.txt"
                sentinel.write_text("leave this alone", encoding="utf-8")
                cache_child.symlink_to(outside, target_is_directory=True)

                result = subprocess.run([str(ENV / "bootstrap.sh")], env=env, text=True, capture_output=True, check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Refusing symlink", result.stderr)
                self.assertEqual(sentinel.read_text(encoding="utf-8"), "leave this alone")
                self.assertFalse((prefix / "overlay").exists())

        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            prefix = temp_path / "prefix"
            _, env = self._fake_bootstrap(temp_path, prefix)
            sentinel = temp_path / "sentinel.lock"
            sentinel.write_text("do not truncate", encoding="utf-8")
            (prefix / ".bootstrap.lock").symlink_to(sentinel)
            result = subprocess.run([str(ENV / "bootstrap.sh")], env=env, text=True, capture_output=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Refusing symlink or non-file bootstrap lock", result.stderr)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "do not truncate")

    def test_failed_mock_extraction_cleans_staging_and_preserves_no_partial_overlay(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            prefix = temp_path / "prefix"
            _, env = self._fake_bootstrap(temp_path, prefix)
            env["FAKE_EXTRACT_FAIL"] = "xauth"
            result = subprocess.run([str(ENV / "bootstrap.sh")], env=env, text=True, capture_output=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((prefix / "overlay").exists())
            self.assertEqual(list(prefix.glob(".overlay-new.*")), [], "temporary staged overlay must be cleaned on failure")
            self.assertFalse((prefix / "fake-curl.log").exists())

    def test_lock_and_scripts_contain_no_private_workspace_paths(self) -> None:
        for path in [LOCK, ENV / "README.md", ENV / "metadata/trixie.InRelease", ENV / "verify_provenance.py", *SCRIPTS]:
            content = path.read_text(encoding="utf-8")
            self.assertNotIn("/workspace/shared", content)
            self.assertNotIn("/workspace/scratch", content)
            self.assertNotIn("/home/agent", content)
        keyring = (ENV / "metadata/debian-archive-keyring.pgp").read_bytes()
        self.assertNotIn(b"/workspace/shared", keyring)


if __name__ == "__main__":
    unittest.main()
