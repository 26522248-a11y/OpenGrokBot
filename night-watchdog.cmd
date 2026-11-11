@echo off
setlocal
netstat -ano | findstr /R /C:":4310 .*LISTENING" >nul 2>&1
if not errorlevel 1 exit /b 0
cd /d "E:\Default Project\OpenGrokBot"
if not exist "logs" mkdir "logs"
start "" /b cmd /c "npm start >> logs\night-server.log 2>&1"
exit /b 0
