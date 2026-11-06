$ErrorActionPreference = 'Stop'

function ConvertTo-NativeArgument([string]$Value) {
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Invoke-SyncCore {
    param([string]$NodePath, [string]$CorePath, [string]$Command, [string]$StatePath, [string]$RunDir)
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $NodePath
    $arguments = @($CorePath, $Command, '--state', $StatePath, '--run-dir', $RunDir)
    $start.Arguments = ($arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $start.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $start.EnvironmentVariables.Remove('CODEX_LOCAL_SYNC_APP_CLOSED')
    if ($Command -eq 'apply') { $start.EnvironmentVariables['CODEX_LOCAL_SYNC_APP_CLOSED'] = '1' }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Could not start the local sync runtime.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) {
            $process.Kill()
            throw 'The local sync runtime timed out. Inspect transaction.json before retrying.'
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        $code = $process.ExitCode
        [IO.File]::WriteAllText((Join-Path $RunDir "$Command.stdout.log"), $stdout, (New-Object System.Text.UTF8Encoding($false)))
        [IO.File]::WriteAllText((Join-Path $RunDir "$Command.stderr.log"), $stderr, (New-Object System.Text.UTF8Encoding($false)))
        $data = $null
        if ($stdout.Trim()) { try { $data = $stdout | ConvertFrom-Json } catch { } }
        return [pscustomobject]@{ ExitCode = $code; Data = $data; ErrorText = $stderr.Trim() }
    } finally { $process.Dispose() }
}

function Get-CodexProcesses([string]$AppPath) {
    @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe' OR Name = 'Codex.exe'" |
        Where-Object { $_.ExecutablePath -eq $AppPath })
}

function Get-CodexMain([string]$AppPath) {
    @(Get-CodexProcesses $AppPath | Where-Object { $_.CommandLine -notmatch '(?:^|\s)--type(?:=|\s)' })
}

function Get-CodexRuntime {
    $packages = @(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending)
    if (-not $packages.Count) { throw 'The packaged Windows Codex app was not found. No application settings were changed.' }
    $candidates = @()
    foreach ($package in $packages) {
        $manifestPath = Join-Path $package.InstallLocation 'AppxManifest.xml'
        [xml]$manifest = Get-Content -LiteralPath $manifestPath
        $application = @($manifest.Package.Applications.Application | Where-Object { $_.Id -eq 'App' })
        if ($application.Count -ne 1) { continue }
        $executable = [IO.Path]::GetFullPath((Join-Path $package.InstallLocation $application[0].Executable))
        $candidates += [pscustomobject]@{ AppPath = $executable; Root = $package.InstallLocation; Version = [string]$package.Version }
    }
    if (-not $candidates.Count) { throw 'Unsupported application manifest. No application settings were changed.' }
    $allMain = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe' OR Name = 'Codex.exe'" |
        Where-Object { $_.ExecutablePath -and $_.CommandLine -notmatch '(?:^|\s)--type(?:=|\s)' })
    # A package update can be registered while an older version is still running.
    foreach ($main in $allMain) {
        if (@($candidates | Where-Object { $_.AppPath -eq $main.ExecutablePath }).Count) { continue }
        $appDirectory = Split-Path -Parent $main.ExecutablePath
        if ((Split-Path -Leaf $appDirectory) -ne 'app') { continue }
        $root = Split-Path -Parent $appDirectory
        $manifestPath = Join-Path $root 'AppxManifest.xml'
        if (-not (Test-Path -LiteralPath $manifestPath)) { continue }
        try {
            [xml]$manifest = Get-Content -LiteralPath $manifestPath
            if ($manifest.Package.Identity.Name -ne 'OpenAI.Codex') { continue }
            $candidates += [pscustomobject]@{ AppPath = $main.ExecutablePath; Root = $root; Version = [string]$manifest.Package.Identity.Version }
        } catch { continue }
    }
    $running = @($candidates | Where-Object { $candidate = $_; @($allMain | Where-Object { $_.ExecutablePath -eq $candidate.AppPath }).Count -gt 0 })
    if ($running.Count -gt 1) { throw 'More than one Codex installation is running. Close the extra instance before syncing.' }
    $selected = if ($running.Count -eq 1) { $running[0] } else { $candidates[0] }
    $nodePath = Join-Path $selected.Root 'app\resources\cua_node\bin\node.exe'
    if (-not (Test-Path -LiteralPath $nodePath)) {
        $command = Get-Command node -ErrorAction SilentlyContinue
        if (-not $command) { throw 'Node.js 20+ is required; the bundled runtime was not found.' }
        $nodePath = $command.Source
    }
    $nodeVersion = & $nodePath --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) { throw 'Node.js 20 or newer is required.' }
    return [pscustomobject]@{ AppPath = $selected.AppPath; NodePath = $nodePath; Version = $selected.Version }
}

function Test-SameProcess($Original) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($Original.ProcessId)"
    return $null -ne $current -and $current.ExecutablePath -eq $Original.ExecutablePath -and
        $current.CreationDate -eq $Original.CreationDate
}

function Stop-CodexForSync($Original) {
    if (-not (Test-SameProcess $Original)) { throw 'The application changed before shutdown. No settings were written.' }
    $family = New-Object 'System.Collections.Generic.HashSet[uint32]'
    $family.Add([uint32]$Original.ProcessId) | Out-Null
    function Find-StateWriters {
        $processes = @(Get-CodexProcesses $Original.ExecutablePath)
        do {
            $added = $false
            foreach ($item in $processes) {
                if ($family.Contains([uint32]$item.ParentProcessId) -and $family.Add([uint32]$item.ProcessId)) { $added = $true }
            }
        } while ($added)
        @($processes | Where-Object { $family.Contains([uint32]$_.ProcessId) -and $_.CommandLine -match '--utility-sub-type=node\.mojom\.NodeService' })
    }
    $writers = @(Find-StateWriters)
    Stop-Process -Id $Original.ProcessId -Force
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $settled = 0
    do {
        $writers += @(Find-StateWriters)
        foreach ($writer in $writers) {
            if (Test-SameProcess $writer) { Stop-Process -Id $writer.ProcessId -Force }
        }
        $remainingWriters = @($writers | Where-Object { Test-SameProcess $_ })
        $mains = @(Get-CodexMain $Original.ExecutablePath)
        if (@($mains | Where-Object { $_.ProcessId -ne $Original.ProcessId }).Count) {
            throw 'Codex reopened during shutdown. No settings were written.'
        }
        if (-not (Test-SameProcess $Original) -and $remainingWriters.Count -eq 0) { $settled++ } else { $settled = 0 }
        if ($settled -ge 2) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Codex state writers did not exit. No settings were written.'
}

function Start-CodexAfterSync([string]$AppPath, [string]$CodexDataPath) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $AppPath
    $start.WorkingDirectory = Split-Path -Parent $AppPath
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $start.EnvironmentVariables['CODEX_HOME'] = $CodexDataPath
    $start.EnvironmentVariables.Remove('CODEX_LOCAL_SYNC_APP_CLOSED')
    $process = [System.Diagnostics.Process]::Start($start)
    if (-not $process) { throw 'Codex could not be reopened.' }
    $process.Dispose()
}

function Invoke-CodexProjectSync {
    param([switch]$CheckOnly, [string]$CodexDataPath, [string]$RunDir, [string]$ToolRoot,
        [int]$CountdownSeconds = 8, [int]$VerificationSeconds = 60)
    $lockStream = $null
    $restartAllowed = $false
    $runtime = $null
    try {
        if (-not $CodexDataPath) { $CodexDataPath = $env:CODEX_HOME }
        if (-not $CodexDataPath) { $CodexDataPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
        $CodexDataPath = [IO.Path]::GetFullPath($CodexDataPath)
        if ($CodexDataPath.StartsWith('\\')) { throw 'Use a local disk for the Codex data directory. Network project folders can remain attached.' }
        $statePath = Join-Path $CodexDataPath '.codex-global-state.json'
        if (-not (Test-Path -LiteralPath $statePath)) { throw 'Codex state was not found. Use -CodexHome for its actual data directory.' }
        if (-not $RunDir) {
            $runRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexLocalProjects\runs'
            $RunDir = Join-Path $runRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
        }
        $RunDir = [IO.Path]::GetFullPath($RunDir)
        New-Item -ItemType Directory -Path $RunDir -Force | Out-Null
        if (-not $CheckOnly) { $lockStream = [IO.File]::Open((Join-Path $CodexDataPath '.local-project-sync.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
        $runtime = Get-CodexRuntime
        $corePath = Join-Path $ToolRoot 'codex-local-projects.cjs'
        $arguments = @{ NodePath = $runtime.NodePath; CorePath = $corePath; StatePath = $statePath; RunDir = $RunDir }
        $result = Invoke-SyncCore @arguments -Command plan
        if ($result.ExitCode -ne 0 -or -not $result.Data) { throw "Plan validation failed. $($result.ErrorText)" }
        $plan = $result.Data
        Write-Host ("Local projects to add: {0}; conversation assignments to add: {1}." -f $plan.addProjects, $plan.addAssignments)
        if ($plan.outcome -eq 'no_local_source') {
            Write-Host 'No recoverable local project records were found in this data directory. Nothing was restored.' -ForegroundColor Yellow
            return 3
        }
        if ($plan.conflictingAssignments -gt 0) {
            Write-Host ("{0} conflicting assignments need manual review and will be skipped." -f $plan.conflictingAssignments) -ForegroundColor Yellow
        }
        if ($CheckOnly -or -not $plan.needsRestart) {
            Write-Host 'Check completed. No application configuration was changed and no restart was performed.'
            if ($plan.conflictingAssignments -gt 0) { return 2 }
            return 0
        }
        $main = @(Get-CodexMain $runtime.AppPath)
        if ($main.Count -ne 1) { throw 'Open Codex, sign in to the destination account, and run the tool again.' }
        $original = $main[0]
        if ($original.CommandLine -match '--(?:user-data-dir|profile-directory)(?:=|\s)') {
            throw 'Custom Chromium profiles are not supported by this launcher. No application settings were changed.'
        }
        Write-Host ("Codex will restart in {0} seconds. Ctrl+C cancels now." -f $CountdownSeconds)
        Start-Sleep -Seconds $CountdownSeconds
        $preflight = Invoke-SyncCore @arguments -Command preflight
        if ($preflight.ExitCode -ne 0 -or -not $preflight.Data) { throw "Account or project data changed before shutdown. $($preflight.ErrorText)" }
        if ($preflight.Data.alreadyPresent) { Write-Host 'The requested records are already present. No restart is necessary.'; return 0 }
        Stop-CodexForSync $original
        $restartAllowed = $true
        $applied = Invoke-SyncCore @arguments -Command apply
        if ($applied.ExitCode -ne 0) { throw $applied.ErrorText }
        $launchStarted = [DateTime]::UtcNow
        Start-CodexAfterSync $runtime.AppPath $CodexDataPath
        $deadline = [DateTime]::UtcNow.AddSeconds($VerificationSeconds)
        $consecutive = 0
        $verified = $false
        do {
            Start-Sleep -Seconds 2
            $checked = Invoke-SyncCore @arguments -Command verify
            $appPersisted = [IO.File]::GetLastWriteTimeUtc($statePath) -ge $launchStarted
            if ($checked.ExitCode -eq 0 -and $checked.Data.success -and $appPersisted -and @(Get-CodexMain $runtime.AppPath).Count -eq 1) {
                $consecutive++
            } else { $consecutive = 0 }
            if ($consecutive -ge 2) { $verified = $true; break }
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $verified) { throw 'Data was written, but a stable read-back after the app persisted its startup state could not be confirmed. Inspect the backup and verify logs.' }
        $report = @{ status = 'verified'; verificationScope = 'persisted_local_state'; appVersion = $runtime.Version;
            projectsAdded = $plan.addProjects; assignmentsAdded = $plan.addAssignments; conflictsSkipped = $plan.conflictingAssignments }
        [IO.File]::WriteAllText((Join-Path $RunDir 'launcher-result.json'), ($report | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
        Write-Host 'Restored metadata survived the application restart and passed two read-back checks.'
        Write-Host ("Backup and logs: {0}" -f $RunDir)
        if ($plan.conflictingAssignments -gt 0) { return 2 }
        return 0
    } catch {
        Write-Host ("ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
        if ($RunDir -and (Test-Path -LiteralPath $RunDir)) {
            try { [IO.File]::WriteAllText((Join-Path $RunDir 'launcher-error.log'), $_.Exception.ToString(), (New-Object System.Text.UTF8Encoding($false))) } catch { }
            Write-Host ("Run folder: {0}" -f $RunDir)
        }
        if ($restartAllowed -and $runtime -and @(Get-CodexMain $runtime.AppPath).Count -eq 0) {
            try { Start-CodexAfterSync $runtime.AppPath $CodexDataPath } catch { Write-Host 'Reopen Codex manually after checking the backup.' }
        }
        return 1
    } finally { if ($lockStream) { $lockStream.Dispose() } }
}
