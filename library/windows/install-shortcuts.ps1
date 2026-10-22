# Puts "Riff Library" (start) and "Riff Library stop" shortcuts on the desktop.
# Run once: powershell -ExecutionPolicy Bypass -File library\windows\install-shortcuts.ps1
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell

$start = $shell.CreateShortcut((Join-Path $desktop 'Riff Library.lnk'))
$start.TargetPath = Join-Path $here 'start.cmd'
$start.WorkingDirectory = (Resolve-Path (Join-Path $here '..\..')).Path
$start.IconLocation = (Join-Path $here 'riff-library.ico')
$start.Description = 'Start the Riff song library service (close its window to stop it)'
$start.WindowStyle = 7 # minimized: it runs in the background, its window shows what it did
$start.Save()

$stop = $shell.CreateShortcut((Join-Path $desktop 'Riff Library stop.lnk'))
$stop.TargetPath = Join-Path $here 'stop.cmd'
$stop.WorkingDirectory = (Resolve-Path (Join-Path $here '..\..')).Path
$stop.IconLocation = "$env:SystemRoot\System32\shell32.dll,27"
$stop.Description = 'Stop the Riff song library service'
$stop.WindowStyle = 7
$stop.Save()

Write-Output "Shortcuts are on the desktop: $desktop"
