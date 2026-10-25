# Build the offline wheelhouse that `gee_setup` installs from.
#
# Windows x64 only for now: the wheels are cp312-win_amd64, which matches the
# Python 3.12 runtime DeepSeek Harness ships.
#
#   powershell -File tools\build-wheels.ps1
#   Compress-Archive -Path wheels -DestinationPath wheels-win-x64.zip
#
# Drop the resulting `wheels/` directory next to dsh-gee/ and `gee_setup`
# installs without any network access.
param(
  [string]$Out = 'wheels',
  [string]$Index = 'https://mirrors.aliyun.com/pypi/simple',
  [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $Out | Out-Null

& $Python -m pip download `
  --no-cache-dir `
  --only-binary=:all: `
  --progress-bar off `
  -i $Index `
  -d $Out `
  earthengine-api tifffile matplotlib

$files = Get-ChildItem $Out -File
$megabytes = ($files | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("wheelhouse: {0} files, {1:N1} MB in {2}" -f $files.Count, $megabytes, $Out)
Write-Host 'next: Compress-Archive -Path wheels -DestinationPath wheels-win-x64.zip'
