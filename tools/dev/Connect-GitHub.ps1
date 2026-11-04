# Connects this ZIP-based checkout to origin. Reads from GitHub and pushes nothing.
# Local commits are replayed on the real history only if the ZIP matches origin/main.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root
git fetch origin
if ($LASTEXITCODE -ne 0) { throw 'Could not read GitHub. Sign in, then run this again.' }
if (-not (git tag --list zip-baseline)) { Write-Host 'Already connected: no zip-baseline tag.'; exit 0 }
if (git status --porcelain) { throw 'Commit your local changes first.' }
$zip = git rev-parse 'zip-baseline^{tree}'
$remote = git rev-parse 'origin/main^{tree}'
if ($zip -ne $remote) {
    Write-Host 'origin/main differs from the ZIP. Nothing was changed. Review it:'
    git diff --stat zip-baseline origin/main
    exit 2
}
$branch = git branch --show-current
git rebase --onto origin/main zip-baseline $branch
if ($LASTEXITCODE -ne 0) { throw 'Rebase stopped. Resolve it, or run: git rebase --abort' }
git branch -f main origin/main
git branch --set-upstream-to=origin/main main
git tag -d zip-baseline
Write-Host "Connected. $branch now sits on origin/main. Nothing was pushed."
