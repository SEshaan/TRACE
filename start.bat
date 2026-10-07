@echo off

echo Starting Backend...
start "Backend Server" cmd /k "python Backend\main.py"

echo Starting Frontend...
start "Frontend Server" cmd /k "cd Frontend && npm run dev"

echo Both servers started.
