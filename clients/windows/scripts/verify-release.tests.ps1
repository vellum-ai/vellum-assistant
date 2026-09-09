$ErrorActionPreference = "Stop"
$verifier = Join-Path $PSScriptRoot "verify-release.ps1"
$fixture = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$testCount = 0

function New-Signature($Publisher = "Example Publisher", $Type = "Authenticode") {
  $certificate = [pscustomobject]@{ Publisher = $Publisher; Thumbprint = [guid]::NewGuid().ToString() }
  $certificate | Add-Member ScriptMethod GetNameInfo { param($NameType, $ForIssuer) $this.Publisher }
  return [pscustomobject]@{ Status = "Valid"; SignatureType = $Type; SignerCertificate = $certificate }
}

function Get-AuthenticodeSignature([string]$FilePath) {
  $signature = $signatures[[IO.Path]::GetFullPath($FilePath)]
  if ($null -eq $signature) { throw "Missing signature fixture: $FilePath" }
  return $signature
}

function Assert-Verification([string]$FailurePattern) {
  $failure = $null
  try { & $verifier -Arch $arch -PublisherName "Example Publisher" }
  catch { $failure = $_.Exception.Message }
  if ($FailurePattern) {
    if (-not $failure -or $failure -notlike $FailurePattern) { throw "Expected '$FailurePattern', got '$failure'" }
  } elseif ($failure) { throw $failure }
  $script:testCount++
}

New-Item -ItemType Directory -Path (Join-Path $fixture "dist") -Force | Out-Null
Push-Location $fixture
try {
  foreach ($arch in @("x64", "arm64")) {
    $appOutDir = if ($arch -eq "x64") { "dist/win-unpacked" } else { "dist/win-$arch-unpacked" }
    $vendorPaths = @("d3dcompiler_47.dll", "dxil.dll", "resources/native-helper/$arch/D3DCompiler_47_cor3.dll")
    $manifest = @{
      files = @(@{ path = "app.exe" }) + @($vendorPaths | ForEach-Object { @{ path = $_ } })
      installers = @(@{ path = "setup.exe" })
    }
    $manifestPath = "dist/signing-manifest-$arch.json"
    $manifest | ConvertTo-Json -Depth 4 | Set-Content $manifestPath
    Set-Content "dist/latest.yml" "version: 1.0.0"
    $signatures = @{}
    $appPath = [IO.Path]::GetFullPath((Join-Path $appOutDir "app.exe"))
    $installerPath = [IO.Path]::GetFullPath("dist/setup.exe")
    $signatures[$appPath] = New-Signature
    $signatures[$installerPath] = New-Signature
    foreach ($relative in $vendorPaths) {
      $signatures[[IO.Path]::GetFullPath((Join-Path $appOutDir $relative))] = New-Signature "Microsoft Windows" "Catalog"
    }
    Assert-Verification

    foreach ($relative in $vendorPaths) {
      $vendorPath = [IO.Path]::GetFullPath((Join-Path $appOutDir $relative))
      $signatures[$vendorPath].Status = "HashMismatch"
      Assert-Verification "*HashMismatch*"
      $signatures[$vendorPath].Status = "Valid"
      $signatures[$vendorPath].SignatureType = "Authenticode"
      Assert-Verification "*unexpected publisher*"
      $signatures[$vendorPath] = New-Signature "Other Publisher" "Catalog"
      Assert-Verification "*unexpected publisher*"
      $signatures[$vendorPath] = New-Signature "Microsoft Windows" "Catalog"
    }

    foreach ($ownedPath in @($appPath, $installerPath)) {
      $signatures[$ownedPath].Status = "NotSigned"
      Assert-Verification "*NotSigned*"
      $signatures[$ownedPath] = New-Signature "Microsoft Windows" "Catalog"
      Assert-Verification "*unexpected publisher*"
      $signatures[$ownedPath] = New-Signature
    }

    $manifest.files += @{ path = "resources/other/dxil.dll" }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content $manifestPath
    $signatures[[IO.Path]::GetFullPath((Join-Path $appOutDir "resources/other/dxil.dll"))] = New-Signature "Microsoft Windows" "Catalog"
    Assert-Verification "*unexpected publisher*"
    $manifest.files = @($manifest.files | Where-Object { $_.path -ne "resources/other/dxil.dll" })
    $manifest | ConvertTo-Json -Depth 4 | Set-Content $manifestPath

    Remove-Item "dist/latest.yml"
    Assert-Verification "*did not write dist/latest.yml*"
    $manifest.installers = @()
    $manifest | ConvertTo-Json -Depth 4 | Set-Content $manifestPath
    Assert-Verification "*lists no installer*"
  }
  Write-Host "Passed $testCount release verification cases"
} finally {
  Pop-Location
  Remove-Item $fixture -Recurse -Force
}
