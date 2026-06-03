@echo off
setlocal
cd /d "%~dp0"

if "%ANDROID_HOME%"=="" (
  if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
)
if "%ANDROID_HOME%"=="" (
  if exist "C:\Main\Productivity\Coding\Android\Sdk\platform-tools\adb.exe" set "ANDROID_HOME=C:\Main\Productivity\Coding\Android\Sdk"
)
if "%ANDROID_HOME%"=="" (
  echo Android SDK was not found. Set ANDROID_HOME and run this again.
  exit /b 1
)

set "PATH=%ANDROID_HOME%\platform-tools;%PATH%"
call gradlew.bat :app:installDebug
if errorlevel 1 exit /b %errorlevel%

adb shell monkey -p dev.revivalside.officialprofilecapture 1
endlocal
