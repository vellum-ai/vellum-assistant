param(
  [Parameter(Mandatory)][ValidateSet("x64", "arm64")][string]$Arch,
  [Parameter(Mandatory)][string]$PublisherName
)

$ErrorActionPreference = "Stop"
$manifest = Get-Content "dist/signing-manifest-$Arch.json" | ConvertFrom-Json
$appOutDir = if ($Arch -eq "x64") { "dist/win-unpacked" } else { "dist/win-$Arch-unpacked" }
$targets = @($manifest.files | ForEach-Object { Join-Path $appOutDir $_.path }) + @($manifest.installers | ForEach-Object { Join-Path "dist" $_.path })
if ($manifest.installers.Count -lt 1) { throw "signing manifest lists no installer" }

# PowerShell prefers Windows catalog signatures over embedded signatures.
$microsoftCatalogFiles = @(
  "d3dcompiler_47.dll"
  "dxil.dll"
  "resources/native-helper/$Arch/D3DCompiler_47_cor3.dll"
) | ForEach-Object { Join-Path $appOutDir $_ }

$bad = @()
$catalogCount = 0
foreach ($file in $targets) {
  $sig = Get-AuthenticodeSignature -FilePath $file
  if ($sig.Status -ne "Valid") { $bad += "$file ($($sig.Status))"; continue }
  $publisher = $sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($publisher -ceq $PublisherName) { continue }
  if ($sig.SignatureType -eq "Catalog" -and $publisher -ceq "Microsoft Windows" -and $microsoftCatalogFiles -contains $file) {
    $catalogCount++
    continue
  }
  $bad += "$file (unexpected publisher '$publisher', signature type '$($sig.SignatureType)')"
}
if ($bad.Count -gt 0) { throw "Unsigned or invalid signatures:`n$($bad -join "`n")" }
Write-Host "Verified $($targets.Count) signatures ($PublisherName; $catalogCount Microsoft catalog DLLs)"
if (-not (Test-Path "dist/latest.yml")) { throw "electron-builder did not write dist/latest.yml" }
