$ErrorActionPreference = "Stop"

$seederDirectory = $PSScriptRoot
$seedPath = Join-Path $seederDirectory "seed.sql"
$databasePath = [System.IO.Path]::GetFullPath(
    (Join-Path $seederDirectory "..\test\test.sqlite")
)

if (-not (Test-Path -LiteralPath $seedPath -PathType Leaf)) {
    throw "Seed SQL file not found: $seedPath"
}

$sqlite = Get-Command sqlite3 -ErrorAction Stop
Get-Content -LiteralPath $seedPath -Raw | & $sqlite.Source $databasePath
if ($LASTEXITCODE -ne 0) {
    throw "sqlite3 failed to seed the database at $databasePath."
}

Write-Host "Created test.sqlite successfully at $databasePath."
