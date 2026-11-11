$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) {
  throw 'Installer smoke test must run on an isolated GitHub Actions runner.'
}

$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$installer = Join-Path $root "release\DocNest-Setup-$version-x64.exe"
$target = 'D:\DocNest'
$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

function Get-DocNestUninstallEntry {
  $uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  if (-not (Test-Path $uninstallRoot)) { return }
  Get-ChildItem $uninstallRoot | Get-ItemProperty | Where-Object { $_.DisplayName -like 'DocNest*' }
}

$createdDrive = $false
if (-not (Test-Path 'D:\')) {
  & subst.exe D: $env:RUNNER_TEMP
  if ($LASTEXITCODE -ne 0) { throw 'Could not create a temporary D drive.' }
  $createdDrive = $true
}

try {
  if ([System.IO.DriveInfo]::new('D:\').DriveType -ne [System.IO.DriveType]::Fixed) { throw 'D drive is not a fixed local disk.' }
  if (Test-Path $target) { throw 'The default installation directory is already occupied.' }
  if ((Get-DocNestUninstallEntry).Count -ne 0) { throw 'DocNest is already registered on this runner.' }

  $install = Start-Process -FilePath $installer -ArgumentList '/S', '/currentuser' -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Silent install failed: $($install.ExitCode)" }

  $entries = @(Get-DocNestUninstallEntry)
  if ($entries.Count -ne 1) { throw 'Installer did not register exactly one uninstall entry.' }
  if (-not (Test-Path (Join-Path $target 'DocNest.exe'))) { throw 'Installer did not use D:\DocNest.' }
  $shortcuts = @(Get-ChildItem $programs -Recurse -Filter 'Uninstall DocNest.lnk')
  if ($shortcuts.Count -ne 1) { throw 'Start menu uninstall shortcut is missing.' }

  $uninstallPath = [regex]::Match($entries[0].UninstallString, '^"([^"]+)"').Groups[1].Value
  if (-not $uninstallPath.StartsWith("$target\", [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $uninstallPath)) {
    throw 'Registered uninstaller is outside the installation directory or missing.'
  }
  $uninstall = Start-Process -FilePath $uninstallPath -ArgumentList '/S', '/currentuser' -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "Silent uninstall failed: $($uninstall.ExitCode)" }
  if ((Get-DocNestUninstallEntry).Count -ne 0 -or (Test-Path (Join-Path $target 'DocNest.exe')) -or (Test-Path $shortcuts[0].FullName)) {
    throw 'Uninstall did not remove the app registration, executable and shortcut.'
  }
  Write-Output 'Fresh installation defaults to D:\DocNest; uninstaller and start menu shortcut work.'
} finally {
  if ($createdDrive) { & subst.exe D: /D }
}
