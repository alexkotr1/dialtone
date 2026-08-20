# Put a Dialtone shortcut on the Desktop.
#
#   powershell -ExecutionPolicy Bypass -File tools\install-shortcut.ps1
#   powershell -ExecutionPolicy Bypass -File tools\install-shortcut.ps1 -StartMenu
#   powershell -ExecutionPolicy Bypass -File tools\install-shortcut.ps1 -Remove
#
# Points straight at electron.exe rather than at `npm start`. A .bat wrapper
# would work but opens a console window that sits behind the app for as long
# as it runs, and closing it kills the call.

param(
  [switch]$StartMenu,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$AppDir   = Split-Path -Parent $PSScriptRoot
$Electron = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
$Icon     = Join-Path $AppDir 'build\icon.ico'

# GetFolderPath, not "$env:USERPROFILE\Desktop": OneDrive redirects the
# Desktop, and writing to the literal path would put the shortcut somewhere
# that is not the desktop you are looking at.
$Desktop = [Environment]::GetFolderPath('Desktop')
$targets = @((Join-Path $Desktop 'Dialtone.lnk'))
if ($StartMenu) {
  $programs = [Environment]::GetFolderPath('Programs')
  $targets += (Join-Path $programs 'Dialtone.lnk')
}

if ($Remove) {
  foreach ($t in $targets) {
    if (Test-Path $t) { Remove-Item $t -Force; Write-Host "removed $t" }
    else { Write-Host "not there: $t" }
  }
  exit 0
}

if (-not (Test-Path $Electron)) {
  Write-Host "Electron is not installed at:" -ForegroundColor Red
  Write-Host "    $Electron"
  Write-Host ""
  Write-Host "Run this first, from $AppDir :"
  Write-Host "    npm install"
  Write-Host "    node node_modules\electron\install.js"
  exit 1
}

if (-not (Test-Path $Icon)) {
  Write-Host "icon missing - generating it"
  & $Electron (Join-Path $AppDir 'tools\make-icon.js') | Out-Null
}

$shell = New-Object -ComObject WScript.Shell
foreach ($t in $targets) {
  $lnk = $shell.CreateShortcut($t)
  $lnk.TargetPath = $Electron
  # Absolute app path rather than "." so the shortcut does not depend on the
  # working directory being interpreted the way we expect.
  $lnk.Arguments = '"' + $AppDir + '"'
  $lnk.WorkingDirectory = $AppDir
  $lnk.IconLocation = "$Icon,0"
  $lnk.Description = 'Dialtone - softphone'
  $lnk.WindowStyle = 1
  $lnk.Save()
  Write-Host "created $t"
}

Write-Host ""
Write-Host "Target: $Electron"
Write-Host "App:    $AppDir"
