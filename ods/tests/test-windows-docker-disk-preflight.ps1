$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root "installers\windows\lib\detection.ps1")

function Assert-Equal {
    param($Actual, $Expected, [string]$Label)
    if ($Actual -ne $Expected) {
        throw "$Label expected '$Expected', got '$Actual'"
    }
}

Assert-Equal (Get-WindowsPathDrive "d:\ods") "D:" "Drive from D: path"
Assert-Equal (Get-WindowsPathDrive "C:\Users\me\ods") "C:" "Drive from C: path"
Assert-Equal (Get-WindowsPathDrive "") "" "Empty path has no drive"

Assert-Equal (Get-WindowsDockerDataPathFromSettings ([pscustomobject]@{
    dataFolder = "E:\DockerDesktop"
})) "E:\DockerDesktop" "settings.json dataFolder"
Assert-Equal (Get-WindowsDockerDataPathFromSettings ([pscustomobject]@{
    DiskImageLocation = "F:\Docker\wsl"
})) "F:\Docker\wsl" "DiskImageLocation"
Assert-Equal (Get-WindowsDockerDataPathFromSettings ([pscustomobject]@{
    "DesktopSettings.Disk.DiskPath" = "G:\DockerData"
})) "G:\DockerData" "Flattened settings-store disk path"
Assert-Equal (Get-WindowsDockerDataPathFromSettings ([pscustomobject]@{
    AutoStart = $true
    SettingsVersion = 43
})) "" "Settings without a disk path"

$defaultPath = Get-WindowsDockerDataPath -LocalAppData "C:\ods-test-localappdata" -RoamingAppData "C:\ods-test-roaming"
Assert-Equal $defaultPath "C:\ods-test-localappdata\Docker\wsl\disk\docker_data.vhdx" "Default VHDX path"

$corruptRoot = Join-Path $env:TEMP "ods-docker-settings-test"
$corruptDocker = Join-Path $corruptRoot "Docker"
New-Item -ItemType Directory -Path $corruptDocker -Force | Out-Null
Set-Content -LiteralPath (Join-Path $corruptDocker "settings-store.json") -Value "{not-json"
$corruptFallback = Get-WindowsDockerDataPath -LocalAppData "C:\ods-test-localappdata" -RoamingAppData $corruptRoot
Remove-Item -LiteralPath $corruptRoot -Recurse -Force
Assert-Equal $corruptFallback "C:\ods-test-localappdata\Docker\wsl\disk\docker_data.vhdx" "Corrupt settings fall back to default VHDX"

$same = Test-WindowsDockerImageDiskSpace `
    -InstallDir "C:\ods" `
    -DockerDataPath "C:\Users\example\Docker\wsl\disk\docker_data.vhdx" `
    -RequiredGB 99999
Assert-Equal $same.SameAsInstall $true "Same-drive Docker disk"
Assert-Equal $same.Sufficient $true "Same-drive check must not double-fail C:"

$split = Test-WindowsDockerImageDiskSpace `
    -InstallDir "D:\ods" `
    -DockerDataPath "C:\Users\example\Docker\wsl\disk\docker_data.vhdx" `
    -RequiredGB 99999
Assert-Equal $split.SameAsInstall $false "Split-drive Docker disk"
Assert-Equal $split.Drive "C:" "Split-drive reports Docker drive"
Assert-Equal $split.Sufficient $false "Split-drive must fail when Docker disk is short"

$preflight = Get-Content -LiteralPath (Join-Path $root "installers\windows\phases\01-preflight.ps1") -Raw
if ($preflight -match 'InstallDir \$\{_sourceDrive\}:\\ods') {
    throw "Phase 01 still tells users to install on the source drive"
}
if ($preflight -notmatch 'Test-WindowsDockerImageDiskSpace') {
    throw "Phase 01 does not check Docker image disk space"
}
if ($preflight -notmatch 'Docker images still use Docker Desktop') {
    throw "Phase 01 lost the cross-drive Docker disk explanation"
}

$requirements = Get-Content -LiteralPath (Join-Path $root "installers\windows\phases\04-requirements.ps1") -Raw
if ($requirements -notmatch 'Test-WindowsDockerImageDiskSpace') {
    throw "Phase 04 does not check Docker image disk space"
}

Write-Host "test-windows-docker-disk-preflight: ok"
