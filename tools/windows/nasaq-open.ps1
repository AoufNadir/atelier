# Opens a project folder from the app: nasaq://open/?p=<folder>
# Only folders under the workshop root (D:\نسق) are opened; anything else is ignored.
param([string]$Url)

$root = 'D:\' + [char]0x0646 + [char]0x0633 + [char]0x0642
$i = $Url.IndexOf('?p=')
if ($i -lt 0) { exit 1 }
$path = [uri]::UnescapeDataString($Url.Substring($i + 3)).TrimEnd('/').Replace('/', '\')

$full = [System.IO.Path]::GetFullPath($path)
if (-not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -and $full -ne $root) { exit 2 }

# A card folder may not exist yet: open the nearest existing parent instead.
while ($full.Length -gt $root.Length -and -not (Test-Path -LiteralPath $full -PathType Container)) {
    $full = Split-Path -Parent $full
}
if (Test-Path -LiteralPath $full -PathType Container) {
    Start-Process -FilePath explorer.exe -ArgumentList ('"' + $full + '"')
}
