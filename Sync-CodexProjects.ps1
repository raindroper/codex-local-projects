param([switch]$CheckOnly, [string]$CodexHome, [string]$RunDir)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    . (Join-Path $PSScriptRoot 'launcher-functions.ps1')
    $syncExitCode = Invoke-CodexProjectSync -CheckOnly:$CheckOnly -CodexDataPath $CodexHome -RunDir $RunDir -ToolRoot $PSScriptRoot
    exit $syncExitCode
} catch {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
    exit 1
}
