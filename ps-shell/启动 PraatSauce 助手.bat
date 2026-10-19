@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

REM 优先用 WorkBuddy 自带的 venv python；找不到就退回系统 python
set "PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if exist "%PY%" goto HAVOPY
set "PY=python"
:HAVOPY

if exist "%~dp0app.py" goto HAVEAPP
echo [错误] 同目录下找不到 app.py，请确认本启动器没有放错位置。
pause
exit /b 1
:HAVEAPP

echo.
echo   使用 Python：%PY%
echo   PraatSauce 助手 正在启动……
echo   启动成功后会自动打开窗口；若窗口没弹出来，请看下方打印的本地服务网址，手动粘到浏览器即可。
echo   关闭这个黑色窗口即可退出程序。
echo.

"%PY%" "%~dp0app.py"
set "RC=%errorlevel%"

if "%RC%"=="0" goto DONE
echo.
echo [错误] 程序退出，退出码 %RC%。请把上面的红色报错发给我。
pause
:DONE

endlocal
