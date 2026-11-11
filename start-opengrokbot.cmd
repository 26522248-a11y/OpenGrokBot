@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing dependencies...
  call npm install || goto :err
)
if not exist "dist\server\index.js" (
  echo Building...
  call npm run build || goto :err
)
echo Starting OpenGrokBot at http://127.0.0.1:4310
start "" http://127.0.0.1:4310
call npm start
goto :eof
:err
echo.
echo Setup failed. See errors above.
pause
