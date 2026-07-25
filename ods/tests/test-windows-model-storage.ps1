$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root "installers\windows\lib\constants.ps1")
. (Join-Path $root "installers\windows\lib\detection.ps1")
. (Join-Path $root "installers\windows\lib\model-storage.ps1")

function Assert-Equal {
    param($Actual, $Expected, [string]$Label)
    if ($Actual -ne $Expected) {
        throw "$Label expected '$Expected', got '$Actual'"
    }
}

function Assert-True {
    param([bool]$Value, [string]$Label)
    if (-not $Value) { throw "$Label expected true" }
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) `
    "ods model storage `$cash O'Brien # contract"
$installDir = Join-Path $tempRoot "install"
$modelsDir = Join-Path $tempRoot "models"

Remove-Item -LiteralPath $tempRoot -Recurse -Force `
    -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $installDir, $modelsDir -Force |
    Out-Null

$savedOverrides = @{}
foreach ($name in @("ODS_MODELS_DIR", "ODS_WIN_MODELS_DIR", "MODELS_DIR")) {
    $savedOverrides[$name] = [Environment]::GetEnvironmentVariable(
        $name,
        [EnvironmentVariableTarget]::Process
    )
}

try {
    $capacityProbe = {
        param($Path, $RequiredGB)
        $script:capacityPath = $Path
        return @{
            Drive = "X:"
            FreeGB = 80
            RequiredGB = $RequiredGB
            Sufficient = $true
        }
    }
    $capacity = Test-ODSWindowsModelStorageCapacity `
        -InstallDir $installDir -ModelsDirOverride $modelsDir `
        -RequiredGB 42 -DiskSpaceProbe $capacityProbe
    Assert-Equal $script:capacityPath ([IO.Path]::GetFullPath($modelsDir)) `
        "Capacity probe target"
    Assert-Equal $capacity.RequiredGB 42 "Capacity requirement"
    Assert-True $capacity.Sufficient "Capacity result"
    Assert-True (-not $capacity.UsesDefault) "Custom directory detection"

    $missingNestedPath = Join-Path $tempRoot "missing\deep\models"
    $nestedDisk = Test-DiskSpace -Path $missingNestedPath -RequiredGB 0
    Assert-True $nestedDisk.Sufficient "Nearest existing parent disk lookup"

    $freshChange = Get-ODSWindowsModelStorageChange `
        -InstallDir $installDir -DesiredModelsDir $modelsDir
    Assert-True (-not $freshChange.ExistingInstall) `
        "Fresh install accepts custom storage"
    Assert-True (-not $freshChange.Changed) `
        "Fresh install is not a migration"

    Push-Location $tempRoot
    try {
        $canonicalRelativeDir = Get-ODSModelsDir `
            -InstallDir $installDir -ModelsDirOverride "relative models"
    } finally {
        Pop-Location
    }
    Push-Location $installDir
    try {
        Assert-Equal (
            Get-ODSModelsDir -InstallDir $installDir `
                -ModelsDirOverride $canonicalRelativeDir
        ) $canonicalRelativeDir "Canonical model root survives cwd change"
    } finally {
        Pop-Location
    }

    $persistedModelsDir = Join-Path $tempRoot "persisted models"
    New-Item -ItemType Directory -Path $persistedModelsDir -Force | Out-Null
    @(
        "ODS_WIN_MODELS_DIR='$persistedModelsDir'"
        "MODELS_DIR='$persistedModelsDir'"
    ) | Set-Content -LiteralPath (Join-Path $installDir ".env")

    $env:ODS_MODELS_DIR = $modelsDir
    Assert-Equal (
        Get-ODSWindowsPersistedModelsDir -InstallDir $installDir
    ) ([IO.Path]::GetFullPath($persistedModelsDir)) `
        "Persisted resolver ignores process override"
    Assert-Equal $env:ODS_MODELS_DIR $modelsDir `
        "Persisted resolver restores process override"

    $sameChange = Get-ODSWindowsModelStorageChange `
        -InstallDir $installDir -DesiredModelsDir $persistedModelsDir
    Assert-True $sameChange.ExistingInstall "Existing install detection"
    Assert-True (-not $sameChange.Changed) "Same-path rerun"

    $changed = Get-ODSWindowsModelStorageChange `
        -InstallDir $installDir -DesiredModelsDir $modelsDir
    Assert-True $changed.Changed "Existing path change detection"
    Assert-Equal $changed.PersistedModelsDir `
        ([IO.Path]::GetFullPath($persistedModelsDir)) `
        "Existing path change reports installed path"
    Assert-Equal $changed.DesiredModelsDir `
        ([IO.Path]::GetFullPath($modelsDir)) `
        "Existing path change reports requested path"

    Assert-True (Test-ODSWindowsModelUpgradeActive -InstallDir $installDir `
            -TaskStateProbe { "Running" }) "Running upgrade task"
    Assert-True (Test-ODSWindowsModelUpgradeActive -InstallDir $installDir `
            -TaskStateProbe { "Queued" }) "Queued upgrade task"
    Assert-True (-not (Test-ODSWindowsModelUpgradeActive -InstallDir $installDir `
                -TaskStateProbe { "Ready" } -StatusProbe { $null })) `
        "Idle upgrade task"
    Assert-True (Test-ODSWindowsModelUpgradeActive -InstallDir $installDir `
            -TaskStateProbe { "Ready" } `
            -StatusProbe { [pscustomobject]@{ status = "failed" } }) `
        "Resumable failed upgrade"
    Assert-True (-not (Test-ODSWindowsModelUpgradeActive `
                -InstallDir $installDir -TaskStateProbe { "" } `
                -StatusProbe { [pscustomobject]@{ status = "failed" } })) `
        "Failed upgrade without a task does not block recovery"
    Assert-True (-not (Test-ODSWindowsModelUpgradeActive `
                -InstallDir $installDir -TaskStateProbe { "Disabled" } `
                -StatusProbe { [pscustomobject]@{ status = "error" } })) `
        "Disabled upgrade task does not claim resumability"
    Assert-True (Test-ODSWindowsModelUpgradeActive -InstallDir $installDir `
            -TaskStateProbe { "Ready" } `
            -StatusProbe {
                [pscustomobject]@{
                    status = "downloading"
                    updatedAt = [DateTimeOffset]::UtcNow.AddMinutes(
                        -10
                    ).ToString("o")
                }
            }) "Restartable stale download"
    Assert-True (-not (Test-ODSWindowsModelUpgradeActive `
                -InstallDir $installDir -TaskStateProbe { "Ready" } `
                -StatusProbe {
                    [pscustomobject]@{ status = "downloading" }
                })) "Active record without heartbeat is not resumable"
    Assert-True (Test-ODSWindowsModelUpgradeActive -InstallDir $installDir `
            -TaskStateProbe { "" } `
            -StatusProbe {
                [pscustomobject]@{
                    status = "verifying"
                    updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
                }
            }) "Fresh direct-process heartbeat"
    Assert-True (-not (Test-ODSWindowsModelUpgradeActive `
                -InstallDir $installDir -TaskStateProbe { "" } `
                -StatusProbe {
                    [pscustomobject]@{
                        status = "swapping"
                        updatedAt = [DateTimeOffset]::UtcNow.AddMinutes(
                            -10
                        ).ToString("o")
                    }
                })) "Stale active record without a task"
    Assert-True (-not (Test-ODSWindowsModelUpgradeActive -InstallDir $installDir `
                -TaskStateProbe { "Ready" } `
                -StatusProbe { [pscustomobject]@{ status = "complete" } })) `
        "Completed upgrade status"

    $upgradeLogDir = Join-Path $installDir "logs"
    New-Item -ItemType Directory -Path $upgradeLogDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $upgradeLogDir "model-upgrade.pid") `
        -Value "4312"
    Assert-True (Test-ODSWindowsModelUpgradeActive -InstallDir $installDir `
            -TaskStateProbe { "" } `
            -StatusProbe { [pscustomobject]@{ status = "failed" } } `
            -ProcessProbe { param($UpgradePid) $UpgradePid -eq 4312 }) `
        "Live direct-process upgrade"
    Assert-True (-not (Test-ODSWindowsModelUpgradeActive `
                -InstallDir $installDir -TaskStateProbe { "Ready" } `
                -StatusProbe { $null } -ProcessProbe { $false })) `
        "Stale upgrade PID"
    Assert-True (Test-ODSWindowsModelUpgradeActive -InstallDir $installDir `
            -TaskStateProbe { "Ready" } `
            -StatusProbe { [pscustomobject]@{ status = "failed" } } `
            -ProcessProbe { $false }) `
        "Stale PID does not hide a restartable failure"

    $installerText = Get-Content -LiteralPath (
        Join-Path $root "installers\windows\install-windows.ps1"
    ) -Raw
    $changeGuardIndex = $installerText.IndexOf(
        'if ($modelStorageChange.Changed)'
    )
    $canonicalAssignmentIndex = $installerText.IndexOf(
        '$ModelsDir = $desiredModelsDir'
    )
    $phaseFiveIndex = $installerText.IndexOf(
        '. (Join-Path $PhasesDir "05-docker.ps1")'
    )
    Assert-True ($canonicalAssignmentIndex -ge 0 -and
        $canonicalAssignmentIndex -lt $phaseFiveIndex) `
        "Relative model root is canonicalized before installer phases"
    Assert-True ($changeGuardIndex -ge 0 -and
        $changeGuardIndex -lt $phaseFiveIndex) `
        "Path-change guard runs before destructive Docker phase"
    Assert-True ($installerText -notmatch `
        'Start-ODSWindowsModelStorageTransaction|Undo-ODSWindowsModelStorageUpgrade') `
        "Installer does not claim unsafe live-path rollback"
    $preflightText = Get-Content -LiteralPath (
        Join-Path $root "installers\windows\phases\01-preflight.ps1"
    ) -Raw
    Assert-True ([regex]::IsMatch(
            $preflightText,
            '\$_modelsOutsideInstall.*\$_modelFsProbe.*docker run',
            [Text.RegularExpressions.RegexOptions]::Singleline
        )) `
        "External model path uses the pinned Docker sharing probe"

    Write-Host "Windows model storage contract passed"
} finally {
    foreach ($name in $savedOverrides.Keys) {
        [Environment]::SetEnvironmentVariable(
            $name,
            $savedOverrides[$name],
            [EnvironmentVariableTarget]::Process
        )
    }
    Remove-Item -LiteralPath $tempRoot -Recurse -Force `
        -ErrorAction SilentlyContinue
}
