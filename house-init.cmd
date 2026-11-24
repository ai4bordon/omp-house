@echo off
setlocal EnableExtensions EnableDelayedExpansion

for %%I in ("%~dp0.") do set "HOUSE_REPO=%%~fI"
for %%I in ("%CD%") do set "PROJECT=%%~fI"
set "CLI=%HOUSE_REPO%\src\house.mjs"
set "PROFILE=%~1"
if not exist "%CLI%" (
  if not defined PROFILE set /p "PROFILE=Installed OMP profile name: "
  if not defined PROFILE (
    echo An installed OMP profile name is required when this file is copied to a project.
    exit /b 1
  )
  set "CLI=%USERPROFILE%\.omp\profiles\!PROFILE!\agent\house\house.mjs"
)
if not exist "%CLI%" (
  echo House CLI not found: %CLI%
  echo Install House in the selected OMP profile with: node install.mjs --profile !PROFILE!
  exit /b 1
)

set "ROLES=%~2"
if not defined ROLES set /p "ROLES=Roles separated by commas (leave empty to choose in /house setup): "

if defined ROLES (
  node "%CLI%" init --scope project --roles "%ROLES%" --cwd "%PROJECT%"
) else (
  node "%CLI%" init --scope project --cwd "%PROJECT%"
)
if errorlevel 1 exit /b 1

echo.
echo House is ready in: %PROJECT%\.house
echo Open both OMP sessions in this project, then run /house setup once and select both sessions.
echo Roles are chosen in /house setup: pick an existing one or type your own.
echo Start with /house start; send messages with /house say ^<sender-role^> [--to ^<roles^>] ^<text^>.
