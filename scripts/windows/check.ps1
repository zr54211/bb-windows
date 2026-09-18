#requires -Version 7.0
param([switch]$Providers)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native Windows is required.' }
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'This distribution currently targets Windows x64.' }
foreach ($name in @('node.exe', 'git.exe', 'pnpm.cmd', 'pwsh.exe')) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "Missing dependency: $name" }
}
$nodeVersion = [version]((& node.exe --version).TrimStart('v'))
if ($nodeVersion -lt [version]'22.19.0') { throw 'Node.js 22.19.0 or newer is required.' }
$pnpmVersion = (& pnpm.cmd --version).Trim()
if ($pnpmVersion -ne '9.15.0') { throw "Expected pnpm 9.15.0, found $pnpmVersion. Install the version pinned in package.json." }
if ($Providers) {
    . (Join-Path $PSScriptRoot 'provider-executables.ps1')
    $resolved = @{ codex = (Find-CodexExecutable); claude = (Find-ClaudeCodeExecutable) }
    foreach ($name in @('codex', 'claude', 'opencode', 'dsh', 'zcode-acp')) {
        $available = $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
        [pscustomobject]@{ ProviderCommand = $name; OnPath = $available; Executable = $resolved[$name] }
    }
    [pscustomobject]@{ ProviderCommand = 'DEEPSEEK_API_KEY'; OnPath = -not [string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY); Executable = $null }
}
Write-Output "Dependencies OK: Node $nodeVersion, pnpm $pnpmVersion, PowerShell $($PSVersionTable.PSVersion)"
