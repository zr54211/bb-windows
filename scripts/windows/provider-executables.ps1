#requires -Version 7.0

function Find-CodexExecutable {
    $direct = Get-Command 'codex.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($direct) { return $direct.Source }
    $shim = Get-Command 'codex' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $shim) { return $null }
    $package = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $shim.Source) 'node_modules/@openai/codex'))
    if (-not (Test-Path -LiteralPath $package)) { return $null }
    $vendors = @()
    foreach ($scope in @((Join-Path $package 'node_modules/@openai'), (Split-Path -Parent $package))) {
        if (-not (Test-Path -LiteralPath $scope)) { continue }
        $vendors += Get-ChildItem -LiteralPath $scope -Directory -Filter 'codex-win32-*' -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'vendor' }
    }
    $vendors += (Join-Path $package 'vendor')
    foreach ($vendor in $vendors) {
        if (-not (Test-Path -LiteralPath $vendor)) { continue }
        $binary = Get-ChildItem -LiteralPath $vendor -Recurse -Filter 'codex.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($binary) { return $binary.FullName }
    }
    return $null
}

function Find-ClaudeCodeExecutable {
    $direct = Get-Command 'claude.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($direct) { return $direct.Source }
    $native = Join-Path $env:USERPROFILE '.local/bin/claude.exe'
    if (Test-Path -LiteralPath $native) { return (Resolve-Path -LiteralPath $native).Path }
    return $null
}
