param([switch]$CheckOnly, [string]$CodexHome, [string]$RunDir)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$scriptPath = Join-Path $PSScriptRoot 'codex-local-projects.cjs'
$wasStopped = $false
$lockStream = $null
$appPath = $null

function Get-AppMain {
    @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe' OR Name = 'Codex.exe'" |
        Where-Object { $_.ExecutablePath -eq $appPath -and $_.CommandLine -notmatch '--type=' })
}
function Test-OriginalProcess($original) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($original.ProcessId)"
    return $null -ne $current -and $current.ExecutablePath -eq $original.ExecutablePath -and $current.CreationDate -eq $original.CreationDate
}

try {
    if (-not $CodexHome) { $CodexHome = $env:CODEX_HOME }
    if (-not $CodexHome) { $CodexHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
    $statePath = Join-Path $CodexHome '.codex-global-state.json'
    if (-not (Test-Path -LiteralPath $statePath)) { throw 'Codex state was not found. Use -CodexHome for a custom data directory.' }
    if (-not $RunDir) {
        $runRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexLocalProjects\runs'
        $RunDir = Join-Path $runRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
    }
    New-Item -ItemType Directory -Path $RunDir -Force | Out-Null
    $lockStream = [System.IO.File]::Open((Join-Path $CodexHome '.local-project-sync.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $package) { throw 'This launcher supports the Windows packaged Codex app. No settings were changed.' }
    [xml]$manifest = Get-Content -LiteralPath (Join-Path $package.InstallLocation 'AppxManifest.xml')
    $application = @($manifest.Package.Applications.Application | Where-Object { $_.Id -eq 'App' })
    if ($application.Count -ne 1) { throw 'Unsupported application manifest. No settings were changed.' }
    $appPath = [System.IO.Path]::GetFullPath((Join-Path $package.InstallLocation $application[0].Executable))
    $nodePath = Join-Path $package.InstallLocation 'app\resources\cua_node\bin\node.exe'
    if (-not (Test-Path -LiteralPath $nodePath)) {
        $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
        if (-not $nodeCommand) { throw 'Node.js 20 or newer is required; bundled Node was not found.' }
        $nodePath = $nodeCommand.Source
    }
    $nodeVersion = & $nodePath --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) { throw 'Node.js 20 or newer is required.' }
    $planText = & $nodePath $scriptPath plan --state $statePath --run-dir $RunDir
    if ($LASTEXITCODE -ne 0) { throw 'Plan validation failed. No app settings were changed.' }
    $plan = $planText | ConvertFrom-Json
    Write-Host ("Local projects to add: {0}; conversation assignments to add: {1}." -f $plan.addProjects, $plan.addAssignments)
    if ($plan.conflictingAssignments -gt 0) { Write-Host ("Skipped {0} conflicting assignments." -f $plan.conflictingAssignments) }
    if ($CheckOnly -or -not $plan.needsRestart) {
        Write-Host 'Check completed. The application was not restarted and its configuration was not changed.'
        exit 0
    }
    $main = @(Get-AppMain)
    if ($main.Count -ne 1) { throw 'Open Codex, sign in to the destination account, and run this tool again.' }
    $original = $main[0]
    $stateHosts = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe' OR Name = 'Codex.exe'" |
        Where-Object { $_.ExecutablePath -eq $appPath -and $_.ParentProcessId -eq $original.ProcessId -and
            $_.CommandLine -match '--utility-sub-type=node\.mojom\.NodeService' })
    Write-Host 'Codex will restart in 8 seconds. Finish running tasks first; Ctrl+C cancels now.'
    Start-Sleep -Seconds 8
    if (-not (Test-OriginalProcess $original)) { throw 'The application changed. No import was performed; run again.' }
    Stop-Process -Id $original.ProcessId -Force
    $wasStopped = $true
    Start-Sleep -Seconds 2
    foreach ($stateHost in $stateHosts) {
        if (Test-OriginalProcess $stateHost) { Stop-Process -Id $stateHost.ProcessId -Force }
    }
    Start-Sleep -Seconds 2
    if (@(Get-AppMain).Count -ne 0) { throw 'The app reopened too early. No import was performed.' }
    foreach ($stateHost in $stateHosts) { if (Test-OriginalProcess $stateHost) { throw 'A previous state writer is still running.' } }
    $env:CODEX_LOCAL_SYNC_APP_CLOSED = '1'
    & $nodePath $scriptPath apply --state $statePath --run-dir $RunDir
    if ($LASTEXITCODE -ne 0) { throw 'Import failed. Review the run folder and its backup.' }
    Start-Process -FilePath $appPath -WindowStyle Hidden
    Start-Sleep -Seconds 10
    $verified = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $verifyText = & $nodePath $scriptPath verify --state $statePath --run-dir $RunDir
        if ($LASTEXITCODE -eq 0 -and @(Get-AppMain).Count -eq 1) { $verified = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $verified) { throw 'Import was written; verification after restart needs review.' }
    Write-Host 'Local project metadata was imported and verified. Other accounts were preserved.'
    Write-Host ("Backup and report: {0}" -f $RunDir)
} catch {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
    if ($wasStopped -and $appPath -and @(Get-AppMain).Count -eq 0) { Start-Process -FilePath $appPath -WindowStyle Hidden }
    if ($RunDir) { Write-Host ("Run folder: {0}" -f $RunDir) }
    exit 1
} finally {
    if ($lockStream) { $lockStream.Dispose() }
}
