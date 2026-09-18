$ErrorActionPreference = "SilentlyContinue"

function Check-Command {
    param([string]$Name, [string[]]$Args = @("--version"))
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $cmd) {
        Write-Host "[MISSING] $Name" -ForegroundColor Red
        return $false
    }

    $output = & $Name @Args 2>&1 | Select-Object -First 1
    Write-Host "[OK]      $Name -> $output" -ForegroundColor Green
    return $true
}

Write-Host "RaceLab Windows environment check" -ForegroundColor Cyan
Write-Host "--------------------------------"

$ok = $true
$ok = (Check-Command "git") -and $ok
$ok = (Check-Command "node") -and $ok
$ok = (Check-Command "pnpm") -and $ok
$ok = (Check-Command "rustc") -and $ok
$ok = (Check-Command "cargo") -and $ok

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($installPath) {
        Write-Host "[OK]      Visual Studio C++ Build Tools -> $installPath" -ForegroundColor Green
    }
    else {
        Write-Host "[MISSING] Visual Studio C++ toolset workload" -ForegroundColor Red
        $ok = $false
    }
}
else {
    Write-Host "[MISSING] Visual Studio Installer / Build Tools" -ForegroundColor Red
    $ok = $false
}

Write-Host ""
if ($ok) {
    Write-Host "Environment looks ready for RaceLab." -ForegroundColor Green
}
else {
    Write-Host "One or more prerequisites are missing. See README.md." -ForegroundColor Yellow
}
