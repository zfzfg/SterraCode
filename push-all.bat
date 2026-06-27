@echo off
setlocal
set REPO_URL=https://github.com/zfzfg/SterraCode.git
set BRANCH=main

echo Initialisiere Git-Repository, falls nicht vorhanden...
if not exist .git (
  git init
  git branch -M %BRANCH%
)

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  git remote add origin %REPO_URL%
) else (
  git remote set-url origin %REPO_URL%
)

if not exist README.md (
  echo README.md wurde erzeugt.
)

if not defined GIT_AUTHOR_NAME (
  git config user.name "SterraCode User"
)
if not defined GIT_AUTHOR_EMAIL (
  git config user.email "sterracode@example.com"
)

echo Fuege nur fuer Nutzer relevante Dateien hinzu...
git add package.json
if exist README.md git add README.md
git add public\
git add server\
git add start.bat
git add start.ps1
git add check-dependencies.bat
git add check-dependencies.ps1
git add push-all.bat
git add push-changes.bat

git diff --cached --quiet
if errorlevel 1 (
  echo Committe Aenderungen...
  git commit -m "Update repository"
  echo Pushe nach GitHub...
  git push -u origin %BRANCH%
) else (
  echo Keine Aenderungen zum Pushen.
)

echo Fertig.
pause
