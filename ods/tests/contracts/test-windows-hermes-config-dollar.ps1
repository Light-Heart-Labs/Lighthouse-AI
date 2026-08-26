# Windows Hermes config dollar-escape behavioral contract (#2928).
# Run: powershell.exe -NoProfile -ExecutionPolicy Bypass -File ods/tests/contracts/test-windows-hermes-config-dollar.ps1
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$LibDir = Join-Path (Join-Path (Join-Path $Root "installers") "windows") "lib"
$Phase = Join-Path (Join-Path (Join-Path $Root "installers") "windows") "phases\06-directories.ps1"

. (Join-Path $LibDir "ui.ps1")

function Update-HermesConfigFile-UnderTest {
    param([string]$Path, [string]$Model, [string]$BaseUrl)

    if (-not (Test-Path $Path)) { return $false }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $content = [System.IO.File]::ReadAllText($Path, $utf8NoBom)
    $modelReplacement = Get-ODSRegexReplacementLiteral -Value $Model
    $baseUrlReplacement = Get-ODSRegexReplacementLiteral -Value $BaseUrl
    $content = $content -replace '(?m)^  default: ".*"\r?$', "  default: `"$modelReplacement`""
    $content = $content -replace '(?m)^  base_url: ".*"\r?$', "  base_url: `"$baseUrlReplacement`""
    [System.IO.File]::WriteAllText($Path, $content, $utf8NoBom)
    $verified = [System.IO.File]::ReadAllText($Path, $utf8NoBom)
    if (-not $verified.Contains("  default: `"$Model`"")) { return $false }
    if (-not $verified.Contains("  base_url: `"$BaseUrl`"")) { return $false }
    return $true
}

$phaseText = Get-Content -LiteralPath $Phase -Raw
if ($phaseText -notmatch 'Get-ODSRegexReplacementLiteral -Value \$Model') {
    throw "06-directories.ps1 must escape Model via Get-ODSRegexReplacementLiteral"
}
if ($phaseText -notmatch 'Get-ODSRegexReplacementLiteral -Value \$BaseUrl') {
    throw "06-directories.ps1 must escape BaseUrl via Get-ODSRegexReplacementLiteral"
}

# Control: production-style pattern collapses '$$' unless escaped.
$raw = '  default: "old"'
$pat = '(?m)^  default: ".*"\r?$'
$controlModel = 'price$$USD'
$mangled = [regex]::Replace($raw, $pat, "  default: `"$controlModel`"")
if ($mangled -eq '  default: "price$$USD"') {
    throw "Expected unescaped $$ replacement to collapse, but it did not: $mangled"
}
if ($mangled -ne '  default: "price$USD"') {
    throw "Unexpected unescaped $$ collapse result: $mangled"
}

# Control: capturing-group patterns rewrite '$1' to the matched group.
$capRaw = '  default: "old-value"'
$capPat = '(?m)^  default: "(.*)"\r?$'
$capModel = 'org/model-$1-preview'
$capMangled = [regex]::Replace($capRaw, $capPat, "  default: `"$capModel`"")
if ($capMangled -ne '  default: "org/model-old-value-preview"') {
    throw "Expected capturing-group `$1 mangling, got: $capMangled"
}

$tmp = Join-Path $env:TEMP ("ods-hermes-dollar-" + [guid]::NewGuid().ToString("N") + ".yaml")
try {
    @(
        'model:'
        '  default: "qwen3.5-9b"'
        '  base_url: "http://llama-server:8080/v1"'
        '  context_length: 8192'
    ) -join "`n" | Set-Content -LiteralPath $tmp -Encoding utf8

    $model = 'org/model-$1-preview'
    $baseUrl = 'http://host/v1/price$$USD'
    if (-not (Update-HermesConfigFile-UnderTest -Path $tmp -Model $model -BaseUrl $baseUrl)) {
        throw "Update-HermesConfigFile-UnderTest returned false"
    }

    $out = Get-Content -LiteralPath $tmp -Raw
    if ($out -notmatch [regex]::Escape("  default: `"$model`"")) {
        throw "Model with `$ was mangled. Got:`n$out"
    }
    if ($out -notmatch [regex]::Escape("  base_url: `"$baseUrl`"")) {
        throw "BaseUrl with `$`$ was mangled. Got:`n$out"
    }

    Write-Host "[PASS] Hermes config dollar escaping preserves model/base_url"
    exit 0
} finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}
