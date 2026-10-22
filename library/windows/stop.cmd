@echo off
rem stops the Riff song library service started by start.cmd
node "%~dp0..\service.js" --stop
timeout /t 3 >nul
