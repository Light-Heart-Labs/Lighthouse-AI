import importlib.util
import pathlib
import unittest
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).parents[1] / "host" / "system_observe.py"
SPEC = importlib.util.spec_from_file_location("system_observe", MODULE_PATH)
assert SPEC and SPEC.loader
system_observe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(system_observe)


class SystemObserveTests(unittest.TestCase):
    def test_gpu_output_is_bounded_and_omits_device_identifiers(self):
        result = mock.Mock(
            returncode=0,
            stdout="NVIDIA GeForce RTX 5070 Laptop GPU, 8151, 573.22\n",
            stderr="",
        )
        with mock.patch.object(system_observe, "_trusted_executable", return_value="/usr/bin/nvidia-smi") as trusted, \
             mock.patch.object(system_observe, "_run", return_value=result):
            value = system_observe.observe_gpu()
        trusted.assert_called_once_with([
            "/usr/lib/wsl/lib/nvidia-smi",
            "/usr/bin/nvidia-smi",
            "/usr/local/bin/nvidia-smi",
        ])
        self.assertEqual(
            value,
            {
                "schemaVersion": 1,
                "kind": "ods-host-gpu",
                "available": True,
                "backend": "nvidia",
                "devices": [{
                    "name": "NVIDIA GeForce RTX 5070 Laptop GPU",
                    "memoryMiB": 8151,
                    "driver": "573.22",
                }],
            },
        )
        self.assertNotIn("uuid", str(value).lower())
        self.assertNotIn("serial", str(value).lower())

    def test_gpu_parser_fails_closed_on_unexpected_output(self):
        result = mock.Mock(returncode=0, stdout="GPU, 123, driver, extra\n", stderr="")
        with mock.patch.object(system_observe, "_trusted_executable", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(system_observe, "_run", return_value=result):
            value = system_observe.observe_gpu()
        self.assertFalse(value["available"])
        self.assertEqual(value["devices"], [])

    def test_tailscale_projection_contains_no_peer_or_address_data(self):
        with mock.patch.object(
            system_observe,
            "_native_tailscale_state",
            return_value=(True, "running", True),
        ):
            value = system_observe.observe_tailscale()
        self.assertEqual(
            value,
            {
                "schemaVersion": 1,
                "kind": "ods-host-tailscale",
                "available": True,
                "state": "running",
                "serviceRunning": True,
            },
        )
        rendered = str(value).lower()
        self.assertNotIn("peer", rendered)
        self.assertNotIn("address", rendered)
        self.assertNotIn("account", rendered)


if __name__ == "__main__":
    unittest.main()
