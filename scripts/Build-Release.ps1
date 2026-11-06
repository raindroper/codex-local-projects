param([string]$Destination)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$distRoot = Join-Path $repoRoot 'dist'
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
$staging = Join-Path $distRoot ('package-' + [guid]::NewGuid().ToString('N'))
$package = Join-Path $staging 'CodexLocalProjects'
New-Item -ItemType Directory -Path $package -Force | Out-Null
try {
    $files = [IO.File]::ReadAllText((Join-Path $repoRoot 'runtime-files.json')) | ConvertFrom-Json
    if ($files -isnot [array] -or -not $files.Count) { throw 'The runtime file manifest must be a nonempty array.' }
    foreach ($file in $files) {
        if ($file -ne [IO.Path]::GetFileName($file)) { throw 'Runtime files must be top-level files.' }
        $source = Join-Path $repoRoot $file
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing runtime file: $file" }
        Copy-Item -LiteralPath $source -Destination (Join-Path $package $file)
    }
    if (-not $Destination) { $Destination = Join-Path $distRoot 'CodexLocalProjects-Windows.zip' }
    $Destination = [IO.Path]::GetFullPath($Destination)
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Compress-Archive -LiteralPath $package -DestinationPath $Destination -Force
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Destination)
    try {
        $actual = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') } | Sort-Object)
        $expected = @($files | ForEach-Object { 'CodexLocalProjects/' + $_ } | Sort-Object)
        if (@(Compare-Object $expected $actual).Count) { throw 'The archive does not match the runtime file manifest.' }
    } finally { $archive.Dispose() }
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Destination)
    try { $hash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
    [IO.File]::WriteAllText(($Destination + '.sha256'), ($hash + '  ' + [IO.Path]::GetFileName($Destination) + "`n"))
    [pscustomobject]@{ Archive = $Destination; Files = $files.Count; SHA256 = $hash } | ConvertTo-Json -Compress
} finally {
    $resolved = [IO.Path]::GetFullPath($staging)
    $prefix = [IO.Path]::GetFullPath($distRoot).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Split-Path -Leaf $resolved).StartsWith('package-')) { throw 'Refusing an unexpected staging cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
