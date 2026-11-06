param([string]$ReportPath)
$ErrorActionPreference = 'Stop'
$toolRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $toolRoot 'launcher-functions.ps1')
$base = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixtureRoot = Join-Path $base ('codex-launcher-test-' + [guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $fixtureRoot 'package'
$appDirectory = Join-Path $packageRoot 'app'
New-Item -ItemType Directory -Path $appDirectory -Force | Out-Null
$script:FixtureAppPath = Join-Path $appDirectory 'ChatGPT.exe'
$untouched = @(CimCmdlets\Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe' OR Name = 'Codex.exe'" |
    Where-Object { $_.CommandLine -notmatch '(?:^|\s)--type(?:=|\s)' })
$reports = New-Object System.Collections.Generic.List[object]

function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Get-AppxPackage { param([string]$Name) [pscustomobject]@{ InstallLocation = $packageRoot; Version = '26.1103.3517.0' } }
function Get-CimInstance {
    param([string]$ClassName, [string]$Filter)
    CimCmdlets\Get-CimInstance -ClassName $ClassName -Filter $Filter |
        Where-Object { $_.ExecutablePath -eq $script:FixtureAppPath }
}
function Stop-Fixture {
    @(CimCmdlets\Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" |
        Where-Object { $_.ExecutablePath -eq $script:FixtureAppPath }) |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 200
}

try {
    @'
<Package><Identity Name="OpenAI.Codex" Version="26.1103.3517.0"/><Applications><Application Id="App" Executable="app/ChatGPT.exe"/></Applications></Package>
'@ | Set-Content -LiteralPath (Join-Path $packageRoot 'AppxManifest.xml') -Encoding utf8
    $source = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
public static class FixtureApp {
  static void Spawn(string extra) {
    var start = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,
      "--type=utility --utility-sub-type=node.mojom.NodeService " + extra);
    start.UseShellExecute = false; start.CreateNoWindow = true;
    Process.Start(start);
  }
  public static int Main(string[] args) {
    string home = Environment.GetEnvironmentVariable("CODEX_HOME");
    if (String.IsNullOrEmpty(home) || !Directory.Exists(home)) return 21;
    string file = Path.Combine(home, ".codex-global-state.json");
    bool writer = Array.IndexOf(args, "--fixture-writer") >= 0;
    bool supervisor = Array.IndexOf(args, "--fixture-supervisor") >= 0;
    if (!writer && !supervisor) {
      string guard = Environment.GetEnvironmentVariable("CODEX_LOCAL_SYNC_APP_CLOSED") ?? "none";
      File.AppendAllText(Path.Combine(home, "fixture-starts.log"), home + "|guard=" + guard + "\n", new UTF8Encoding(false));
      Spawn("--fixture-supervisor");
    } else if (supervisor) Spawn("--fixture-writer");
    else {
      string cached = File.ReadAllText(file);
      DateTime started = DateTime.UtcNow;
      bool overwrite = File.Exists(Path.Combine(home, "overwrite-after-restart")) &&
        File.ReadAllLines(Path.Combine(home, "fixture-starts.log")).Length > 1;
      File.WriteAllText(Path.Combine(home, "writer-ready"), "ready");
      while (true) {
        if (overwrite && (DateTime.UtcNow - started).TotalSeconds > 3)
          cached = File.ReadAllText(Path.Combine(home, "initial.fixture.json"));
        string temp = file + ".fixture-" + Process.GetCurrentProcess().Id + ".tmp";
        try {
          File.WriteAllText(temp, cached, new UTF8Encoding(false));
          File.Replace(temp, file, null);
        } catch (IOException) { }
        Thread.Sleep(150);
      }
    }
    while (true) Thread.Sleep(200);
  }
}
'@
    Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $script:FixtureAppPath -OutputType ConsoleApplication
    foreach ($case in @('restore', 'no-source', 'startup-overwrite')) {
        Stop-Fixture
        $label = 'profile ' + [char]0x4E2D + [char]0x6587 + ' spaces ' + $case
        $dataRoot = Join-Path $fixtureRoot $label
        New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
        $statePath = Join-Path $dataRoot '.codex-global-state.json'
        $project = @{ id = 'project-example'; name = 'Example'; rootPaths = @($dataRoot); createdAt = 1; updatedAt = 1 }
        $sourceScope = @{ atoms = @{}; globals = @{
            'local-projects' = @{ 'project-example' = $project }
            'thread-project-assignments' = @{ 'thread-example' = @{ projectKind = 'local'; projectId = 'project-example' } }
        } }
        $inactive = if ($case -eq 'no-source') { @{} } else { @{ source = $sourceScope } }
        $state = @{
            'electron-account-renderer-state-v1' = @{ owner = 'target'; inactive = $inactive }
            'electron-persisted-atom-state' = @{ cloudSentinel = 'keep-current' }
        }
        $initialText = $state | ConvertTo-Json -Depth 20 -Compress
        [IO.File]::WriteAllText($statePath, $initialText, (New-Object System.Text.UTF8Encoding($true)))
        [IO.File]::WriteAllText((Join-Path $dataRoot 'initial.fixture.json'), $initialText)
        if ($case -eq 'startup-overwrite') { New-Item -ItemType File -Path (Join-Path $dataRoot 'overwrite-after-restart') | Out-Null }
        $env:CODEX_LOCAL_SYNC_APP_CLOSED = 'must-not-leak'
        Start-CodexAfterSync $script:FixtureAppPath $dataRoot
        $waitUntil = [DateTime]::UtcNow.AddSeconds(10)
        while (-not (Test-Path -LiteralPath (Join-Path $dataRoot 'writer-ready'))) {
            if ([DateTime]::UtcNow -gt $waitUntil) { throw 'Fixture writer did not start.' }
            Start-Sleep -Milliseconds 100
        }
        $runDir = (Join-Path $dataRoot 'reports with spaces') + '\'
        $code = Invoke-CodexProjectSync -CodexDataPath $dataRoot -RunDir $runDir -ToolRoot $toolRoot -CountdownSeconds 0 -VerificationSeconds 9
        $starts = @(Get-Content -LiteralPath (Join-Path $dataRoot 'fixture-starts.log') -Encoding UTF8)
        if ($case -eq 'restore') {
            Assert-True ($code -eq 0) 'The full restore lifecycle failed.'
            Assert-True ($starts.Count -eq 2) 'The app was not restarted exactly once.'
            Assert-True (@($starts | Where-Object { $_ -notlike '*|guard=none' }).Count -eq 0) 'The internal apply guard leaked into the restarted app.'
            $after = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
            Assert-True ($after.'local-projects'.'project-example'.rootPaths[0] -eq $dataRoot) 'The custom data-directory project was not restored.'
            Assert-True ($after.'thread-project-assignments'.'thread-example'.projectId -eq 'project-example') 'The conversation assignment was not restored.'
            Assert-True (Test-Path -LiteralPath (Join-Path $runDir 'state.before.json')) 'The backup is missing.'
            Assert-True (Test-Path -LiteralPath (Join-Path $runDir 'launcher-result.json')) 'The verified result is missing.'
        } elseif ($case -eq 'no-source') {
            Assert-True ($code -eq 3) 'An empty history was incorrectly reported as success.'
            Assert-True ($starts.Count -eq 1) 'An empty history unexpectedly restarted the app.'
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $runDir 'state.before.json'))) 'An empty history unexpectedly performed a write.'
        } else {
            Assert-True ($code -eq 1) 'A startup overwrite was incorrectly reported as a successful recovery.'
            Assert-True (Test-Path -LiteralPath (Join-Path $runDir 'launcher-error.log')) 'The startup failure was not recorded.'
            Assert-True (Test-Path -LiteralPath (Join-Path $runDir 'state.before.json')) 'The original backup was lost.'
        }
        $reports.Add([pscustomobject]@{ Case = $case; Passed = $true; ExitCode = $code; AppStarts = $starts.Count })
    }
    foreach ($original in $untouched) {
        $current = CimCmdlets\Get-CimInstance Win32_Process -Filter "ProcessId = $($original.ProcessId)"
        Assert-True ($null -ne $current -and $current.CreationDate -eq $original.CreationDate) 'A non-fixture app was touched.'
    }
    if ($ReportPath) { $reports | ConvertTo-Json | Set-Content -LiteralPath $ReportPath -Encoding utf8 }
    $reports | ConvertTo-Json -Compress | Write-Output
} finally {
    Stop-Fixture
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    $prefix = [IO.Path]::GetFullPath($base).TrimEnd('\') + '\'
    Assert-True ($resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) 'Fixture cleanup escaped the temporary directory.'
    Assert-True ((Split-Path -Leaf $resolved).StartsWith('codex-launcher-test-')) 'Unexpected fixture cleanup directory.'
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
