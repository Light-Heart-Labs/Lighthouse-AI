$ErrorActionPreference = "Stop"

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$cliPath = Join-Path $root "installers\windows\ods.ps1"
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $cliPath,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -gt 0) {
    throw "Windows CLI failed to parse: $($errors[0].Message)"
}

$updateAst = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq "Invoke-Update"
}, $true)
if (-not $updateAst) {
    throw "Invoke-Update was not found"
}
. ([scriptblock]::Create($updateAst.Extent.Text))

$script:composeCalls = @()
$script:statusCalled = $false
$InstallDir = "C:\ods-test"

function Test-Install { }
function Ensure-LlamaCpuBudget { }
function Get-ComposeFlags { return @("-f", "docker-compose.base.yml") }
function Push-Location { param([string]$Path) }
function Pop-Location { }
function Write-AI { param([string]$Message) }
function Write-AISuccess { param([string]$Message) }
function Write-AIError { param([string]$Message) }
function Write-ODSComposeDiagnostics {
    param([string]$InstallDir, [string[]]$ComposeFlags, [string]$Phase)
}
function Start-Sleep { param([int]$Seconds) }
function Invoke-Status { $script:statusCalled = $true }
function Invoke-ODSDockerCompose {
    param(
        [string]$InstallDir,
        [string[]]$ComposeFlags,
        [string[]]$ComposeArgs
    )
    $script:composeCalls += ,@($ComposeArgs)
    return 0
}

Invoke-Update

if ($script:composeCalls.Count -ne 2) {
    throw "Update executed $($script:composeCalls.Count) compose commands instead of pull and up"
}

$pullArgs = $script:composeCalls[0]
if (($pullArgs -join " ") -ne "pull --ignore-buildable") {
    throw "Update pull arguments changed: $($pullArgs -join ' ')"
}

$upArgs = $script:composeCalls[1]
if (($upArgs -join " ") -ne "up -d --force-recreate") {
    throw "Update recreate arguments changed: $($upArgs -join ' ')"
}

if (-not $script:statusCalled) {
    throw "Update no longer reaches its post-update status receipt"
}

Write-Host "[PASS] Windows CLI update skips pull attempts for build-only services"
