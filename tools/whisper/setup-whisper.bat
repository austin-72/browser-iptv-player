@echo off
rem Sets up "Subtitles made from the sound" for a Docker install on Windows.
rem   1. Builds whisper.cpp's program for the app's image: Docker downloads Alpine Linux, its build tools and
rem      whisper.cpp's source from github.com/ggml-org/whisper.cpp, and compiles it. A few minutes.
rem   2. Downloads a model file from huggingface.co/ggerganov/whisper.cpp.
rem Both go into the data\whisper folder of the server, where the app looks for them. Nothing else is changed and
rem the server is not restarted.
rem
rem   setup-whisper.bat [model]      tiny, base, small, medium, large-v3-turbo ...   small if none is given
setlocal
set "MODEL=%~1"
if "%MODEL%"=="" set "MODEL=small"
set "HERE=%~dp0"
set "ROOT="
for %%D in ("%HERE%..\.." "%HERE%..\..\..") do if not defined ROOT if exist "%%~fD\docker-compose.yml" if exist "%%~fD\data\" set "ROOT=%%~fD"
if not defined ROOT goto noroot
set "OUT=%ROOT%\data\whisper"
if not exist "%OUT%" mkdir "%OUT%"
where docker >nul 2>nul
if errorlevel 1 goto nodocker

echo.
echo Step 1 of 2: building whisper.cpp for the app's image. A few minutes the first time.
echo.
docker build --output "type=local,dest=%OUT%" "%HERE%."
if errorlevel 1 goto buildfailed
if not exist "%OUT%\whisper-cli" goto buildfailed

echo.
echo Step 2 of 2: the %MODEL% model.
echo.
if exist "%OUT%\ggml-%MODEL%.bin" goto havemodel
curl.exe -L --fail --progress-bar -o "%OUT%\ggml-%MODEL%.bin.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-%MODEL%.bin"
if errorlevel 1 goto dlfailed
move /y "%OUT%\ggml-%MODEL%.bin.part" "%OUT%\ggml-%MODEL%.bin" >nul
goto done

:havemodel
echo Already there.

:done
echo.
echo Done. In %OUT%:
dir /b "%OUT%"
echo.
echo Now restart the server, or in the app: Admin - Integrations - Subtitles made from the sound - Look again.
goto end

:noroot
echo Could not find the server's folder: the one with docker-compose.yml and data in it, above this one.
goto end
:nodocker
echo Docker was not found. Start Docker Desktop and run this again.
goto end
:buildfailed
echo.
echo The program could not be built - see above. Nothing was changed.
goto end
:dlfailed
if exist "%OUT%\ggml-%MODEL%.bin.part" del "%OUT%\ggml-%MODEL%.bin.part"
echo.
echo The model could not be downloaded. Is "%MODEL%" one of whisper.cpp's models? Run this again to retry.
:end
echo.
pause
