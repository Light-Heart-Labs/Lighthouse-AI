from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_partial_gpu_offload_profile_reaches_every_llama_launch_path():
    compose = _read("docker-compose.base.yml")
    host_agent = _read("bin/ods-host-agent.py")
    windows_cli = _read("installers/windows/ods.ps1")
    windows_installer = _read("installers/windows/install-windows.ps1")

    assert '- "${N_GPU_LAYERS:-999}"' in compose
    assert 'env.get("N_GPU_LAYERS", "999")' in host_agent
    assert '$gpuLayers = $envVars["N_GPU_LAYERS"]' in windows_cli
    assert '$gpuLayers = $_llamaEnv["N_GPU_LAYERS"]' in windows_installer
    assert '"--n-gpu-layers", $gpuLayers' in windows_cli
    assert '"--n-gpu-layers", $gpuLayers' in windows_installer


def test_macos_native_runtime_includes_cohere2_moe_support():
    constants = _read("installers/macos/lib/constants.sh")

    assert 'LLAMA_CPP_RELEASE_TAG="b9637"' in constants
