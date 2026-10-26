@echo off
cd /d "%~dp0"
start "" http://localhost:5173
npx --yes http-server -p 5173 -c-1 .
