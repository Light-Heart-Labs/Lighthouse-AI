# ============================================================================
# ODS Windows -- model storage preflight
# ============================================================================

function Test-ODSWindowsModelStorageCapacity {
    <#
    .SYNOPSIS
        Check free space on the volume that will actually hold model files.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [string]$ModelsDirOverride = "",
        [Parameter(Mandatory = $true)][int]$RequiredGB,
        [scriptblock]$DiskSpaceProbe
    )

    $modelsDir = Get-ODSModelsDir `
        -InstallDir $InstallDir -ModelsDirOverride $ModelsDirOverride
    $defaultModelsDir = [System.IO.Path]::GetFullPath(
        (Join-Path (Join-Path $InstallDir "data") "models")
    )
    $disk = if ($DiskSpaceProbe) {
        & $DiskSpaceProbe $modelsDir $RequiredGB
    } else {
        Test-DiskSpace -Path $modelsDir -RequiredGB $RequiredGB
    }

    return @{
        Drive       = $disk.Drive
        FreeGB      = $disk.FreeGB
        RequiredGB  = $RequiredGB
        Sufficient  = [bool]$disk.Sufficient
        ModelsDir   = $modelsDir
        UsesDefault = $modelsDir.Equals(
            $defaultModelsDir,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    }
}

function Get-ODSWindowsPersistedModelsDir {
    <#
    .SYNOPSIS
        Resolve the installed model root without process-level overrides.
    #>
    param([Parameter(Mandatory = $true)][string]$InstallDir)

    $savedOverrides = @{}
    foreach ($name in @("ODS_MODELS_DIR", "ODS_WIN_MODELS_DIR", "MODELS_DIR")) {
        $savedOverrides[$name] = [Environment]::GetEnvironmentVariable(
            $name,
            [EnvironmentVariableTarget]::Process
        )
        [Environment]::SetEnvironmentVariable(
            $name,
            $null,
            [EnvironmentVariableTarget]::Process
        )
    }
    try {
        return Get-ODSModelsDir -InstallDir $InstallDir
    } finally {
        foreach ($name in $savedOverrides.Keys) {
            [Environment]::SetEnvironmentVariable(
                $name,
                $savedOverrides[$name],
                [EnvironmentVariableTarget]::Process
            )
        }
    }
}

function Get-ODSWindowsModelStorageChange {
    <#
    .SYNOPSIS
        Compare a requested model root with an existing installation.
    .DESCRIPTION
        Changing the model root of a live installation is intentionally not
        performed by the installer. Windows upgrades replace live source and
        Compose state; a safe data migration requires a dedicated transaction.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [Parameter(Mandatory = $true)][string]$DesiredModelsDir
    )

    $envPath = Join-Path $InstallDir ".env"
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        return [pscustomobject]@{
            ExistingInstall = $false
            Changed = $false
            PersistedModelsDir = ""
            DesiredModelsDir = [System.IO.Path]::GetFullPath($DesiredModelsDir)
        }
    }

    $persistedModelsDir = Get-ODSWindowsPersistedModelsDir `
        -InstallDir $InstallDir
    $desired = [System.IO.Path]::GetFullPath($DesiredModelsDir)
    return [pscustomobject]@{
        ExistingInstall = $true
        Changed = -not $desired.Equals(
            [System.IO.Path]::GetFullPath($persistedModelsDir),
            [System.StringComparison]::OrdinalIgnoreCase
        )
        PersistedModelsDir = $persistedModelsDir
        DesiredModelsDir = $desired
    }
}

function Test-ODSWindowsModelUpgradeActive {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [scriptblock]$TaskStateProbe,
        [scriptblock]$ProcessProbe,
        [scriptblock]$StatusProbe
    )

    $taskState = ""
    if ($TaskStateProbe) {
        $taskState = [string](& $TaskStateProbe)
    } else {
        try {
            $task = Get-ScheduledTask -TaskName "ODSModelUpgrade" `
                -ErrorAction SilentlyContinue
            if ($task) { $taskState = [string]$task.State }
        } catch { }
    }
    if ($taskState -in @("Running", "Queued")) { return $true }
    $restartableTask = $taskState -eq "Ready"

    $status = $null
    if ($StatusProbe) {
        $status = & $StatusProbe
    } else {
        $statusPath = Join-Path (Join-Path $InstallDir "data") `
            "bootstrap-status.json"
        if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
            try {
                $status = Get-Content -LiteralPath $statusPath -Raw |
                    ConvertFrom-Json
            } catch { }
        }
    }
    $pidPath = Join-Path (Join-Path $InstallDir "logs") "model-upgrade.pid"
    if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
        $upgradePid = 0
        if ([int]::TryParse(
                (Get-Content -LiteralPath $pidPath -Raw).Trim(),
                [ref]$upgradePid
            ) -and $upgradePid -gt 0) {
            if ($ProcessProbe) {
                if ([bool](& $ProcessProbe $upgradePid)) { return $true }
            } elseif (Get-Process -Id $upgradePid -ErrorAction SilentlyContinue) {
                return $true
            }
        }
    }

    if (-not $status) { return $false }

    $statusName = ([string]$status.status).Trim().ToLowerInvariant()
    if ($statusName -in @("failed", "error")) {
        return $restartableTask
    }
    if ($statusName -notin @(
            "starting", "downloading", "verifying", "swapping"
        )) {
        return $false
    }

    $updatedRaw = [string]$status.updatedAt
    if ([string]::IsNullOrWhiteSpace($updatedRaw)) { return $false }
    try {
        $updatedAt = [DateTimeOffset]::Parse($updatedRaw).ToUniversalTime()
    } catch {
        return $false
    }
    $staleSeconds = 120
    if ($env:ODS_BOOTSTRAP_UPGRADE_STALE_SECONDS -match "^[0-9]+$") {
        $staleSeconds = [int]$env:ODS_BOOTSTRAP_UPGRADE_STALE_SECONDS
    }
    $ageSeconds = ([DateTimeOffset]::UtcNow - $updatedAt).TotalSeconds
    if ($ageSeconds -le $staleSeconds) { return $true }

    # `ods start` can restart a stale active record only through a ready task.
    return $restartableTask
}
