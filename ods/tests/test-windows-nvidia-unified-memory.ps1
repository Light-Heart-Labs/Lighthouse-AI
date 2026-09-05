$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$detectionPath = Join-Path $root "installers\windows\lib\detection.ps1"

function Assert-Equal {
    param($Actual, $Expected, [string]$Label)
    if ($Actual -ne $Expected) {
        throw "$Label expected '$Expected', got '$Actual'"
    }
}

# Mock nvidia-smi and Win32_ComputerSystem before sourcing detection.ps1, so
# Get-GpuInfo's calls resolve to these fakes instead of touching real hardware.
function nvidia-smi {
    if ($env:MOCK_NVIDIA_SMI_OUTPUT) {
        return $env:MOCK_NVIDIA_SMI_OUTPUT -split "`n"
    }
    return $null
}
$global:LASTEXITCODE = 0

function Get-CimInstance {
    param($ClassName, $ErrorAction)
    if ($ClassName -eq "Win32_ComputerSystem") {
        return [pscustomobject]@{ TotalPhysicalMemory = [uint64](128GB) }
    }
    return @()
}

. $detectionPath

# Regression: unified-memory NVIDIA systems (GB10, GB200) report "[N/A]" for
# memory.total. Get-GpuInfo must fall back to system RAM instead of throwing
# on [int]"" and silently reporting "no GPU" (Backend falls through to none).
$env:MOCK_NVIDIA_SMI_OUTPUT = "NVIDIA GB10, [N/A], 580.65.06, 12.1"
$global:LASTEXITCODE = 0
$info = Get-GpuInfo
Assert-Equal $info.Backend "nvidia" "Unified-memory GPU must still report nvidia backend"
Assert-Equal $info.MemoryType "unified" "Unified-memory GPU must be classified as unified"
Assert-Equal $info.VramMB 131072 "Unified-memory GPU must use system RAM as VRAM budget (128GB)"

# Discrete NVIDIA GPUs (a real memory.total value) must be unaffected.
$env:MOCK_NVIDIA_SMI_OUTPUT = "NVIDIA GeForce RTX 4090, 24564 MiB, 560.94, 8.9"
$global:LASTEXITCODE = 0
$discreteInfo = Get-GpuInfo
Assert-Equal $discreteInfo.Backend "nvidia" "Discrete GPU must report nvidia backend"
Assert-Equal $discreteInfo.MemoryType "discrete" "Discrete GPU must be classified as discrete"
Assert-Equal $discreteInfo.VramMB 24564 "Discrete GPU VRAM must come from nvidia-smi, not system RAM"

Remove-Item Env:\MOCK_NVIDIA_SMI_OUTPUT -ErrorAction SilentlyContinue

Write-Host "[PASS] Windows NVIDIA unified-memory detection fallback"
