@echo off
rem Riff song library: runs until this window is closed (or the "Riff Library stop" shortcut is used)
title Riff Library
cd /d "%~dp0..\.."
node library\service.js %*
