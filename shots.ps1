# Dev helper: render each screen to a PNG using the app's own capturePage,
# so reviewing the UI never involves screenshotting the whole desktop.
#
#   .\shots.ps1                      -> .\shots\*.png
#   .\shots.ps1 -OutDir C:\somewhere

param(
  [string]$OutDir = "$PSScriptRoot\shots",
  [string[]]$Routes = @('dialer', 'recents', 'contacts', 'settings'),
  [switch]$Light
)

$electron = Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  Write-Error "Electron binary missing. Run: node node_modules\electron\install.js"
  exit 1
}

New-Item -ItemType Directory -Force $OutDir | Out-Null

foreach ($route in $Routes) {
  $suffix = if ($Light) { "-light" } else { "" }
  # ':' is legal in a route name ("call:connected") but on NTFS it opens an
  # alternate data stream instead of a file, which silently produces no image.
  $safe = $route -replace ':', '-'
  $out = Join-Path $OutDir "$safe$suffix.png"
  $args = @('.', '--dev', '--seed', '--shot', $out, '--route', $route)
  if ($Light) { $args += @('--theme', 'light') }

  $p = Start-Process -FilePath $electron -ArgumentList $args -PassThru -Wait `
       -RedirectStandardOutput "$OutDir\$route.log" -RedirectStandardError "$OutDir\$route.err"
  $errors = Get-Content "$OutDir\$route.err" -ErrorAction SilentlyContinue |
            Where-Object { $_ -match 'renderer:ERROR|Uncaught|failed' }
  if ($errors) { Write-Host "[$route] $($errors -join '; ')" -ForegroundColor Red }
  if (Test-Path $out) {
    Write-Host ("{0,-10} {1,7:N0} bytes" -f $route, (Get-Item $out).Length) -ForegroundColor Green
  } else {
    Write-Host "$route  NO IMAGE (exit $($p.ExitCode))" -ForegroundColor Red
  }
}

Get-ChildItem $OutDir -Filter *.log | Remove-Item -ErrorAction SilentlyContinue
Write-Host "`n$OutDir"
