[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$JavaHome,
    [Parameter(Mandatory = $true)][string]$AndroidJar,
    [Parameter(Mandatory = $true)][string]$BuildTools,
    [Parameter(Mandatory = $true)][string]$SiteDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [switch]$InitializeSigning
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Windows user DPAPI is required for this signing script.'
}

$utf8 = New-Object Text.UTF8Encoding($false)
$packageId = 'io.github.aureliuswu.fundval'
$androidNamespace = 'http://schemas.android.com/apk/res/android'
$keyAlias = 'fundval-release'
$passwordVariable = 'FUNDVAL_ANDROID_RELEASE_STORE_PASSWORD'
$signingParent = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'FundVal'
$signingDirectory = Join-Path $signingParent 'Signing'
$keyStore = Join-Path $signingDirectory 'fundval-release.p12'
$passwordFile = Join-Path $signingDirectory 'store-password.dpapi'

function Resolve-RegularFile([string]$Path) {
    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'A regular, non-reparse input file is required.'
    }
    return $item.FullName
}

function Resolve-RegularDirectory([string]$Path) {
    $item = Get-Item -LiteralPath $Path
    if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'A regular, non-reparse input directory is required.'
    }
    return $item.FullName
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Native command $([IO.Path]::GetFileName($Executable)) failed (exit $LASTEXITCODE)."
    }
}

function Get-FileSha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-Utf8File([string]$Path, [string]$Value) {
    if (Test-Path -LiteralPath $Path) { throw 'Refusing to overwrite a build evidence file.' }
    [IO.File]::WriteAllText($Path, $Value, $utf8)
}

function Test-WebAssetArchive([string]$Apk, [string]$AssetRoot) {
    $archive = [IO.Compression.ZipFile]::OpenRead($Apk)
    try {
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $count = 0
        foreach ($entry in $archive.Entries) {
            $entryName = $entry.FullName
            if ($entryName.Contains('\') -or !$seen.Add($entryName)) {
                throw 'APK contains a noncanonical or duplicate ZIP path.'
            }
            if (!$entryName.StartsWith('assets/', [StringComparison]::Ordinal) -or $entryName.EndsWith('/')) { continue }
            $relative = $entryName.Substring('assets/'.Length)
            if ($relative -notmatch '^www(/[A-Za-z0-9][A-Za-z0-9_.-]*)+$') {
                throw 'APK contains an unexpected asset path.'
            }
            $sourcePath = Resolve-RegularFile (Join-Path $AssetRoot $relative)
            $stream = $entry.Open()
            try { $entrySha = (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash.ToLowerInvariant() }
            finally { $stream.Dispose() }
            if ($entrySha -ne (Get-FileSha256 $sourcePath)) { throw 'APK asset byte mismatch.' }
            $count++
        }
        if ($count -ne @(Get-ChildItem -LiteralPath $AssetRoot -File -Recurse).Count) {
            throw 'APK asset inventory mismatch.'
        }
        return $count
    } finally { $archive.Dispose() }
}

function Test-SigningInputs {
    if (Test-Path -LiteralPath $signingParent) {
        $null = Resolve-RegularDirectory $signingParent
    }
    if ($InitializeSigning) {
        if (Test-Path -LiteralPath $signingDirectory) {
            throw 'Signing directory exists. Initialization never replaces existing or partially created signing files.'
        }
    } else {
        if (!(Test-Path -LiteralPath $signingDirectory)) {
            throw 'FundVal release key is not initialized. Use -InitializeSigning for a first install only.'
        }
        $null = Resolve-RegularDirectory $signingDirectory
        $null = Resolve-RegularFile $keyStore
        $null = Resolve-RegularFile $passwordFile
    }
}

$jdk = Resolve-RegularDirectory $JavaHome
$sdkTools = Resolve-RegularDirectory $BuildTools
$platformJar = Resolve-RegularFile $AndroidJar
$site = Resolve-RegularDirectory $SiteDirectory
$java = Resolve-RegularFile (Join-Path $jdk 'bin/java.exe')
$javac = Resolve-RegularFile (Join-Path $jdk 'bin/javac.exe')
$jar = Resolve-RegularFile (Join-Path $jdk 'bin/jar.exe')
$keytool = Resolve-RegularFile (Join-Path $jdk 'bin/keytool.exe')
$aapt = Resolve-RegularFile (Join-Path $sdkTools 'aapt.exe')
$aapt2 = Resolve-RegularFile (Join-Path $sdkTools 'aapt2.exe')
$zipalign = Resolve-RegularFile (Join-Path $sdkTools 'zipalign.exe')
$d8Jar = Resolve-RegularFile (Join-Path $sdkTools 'lib/d8.jar')
$signerJar = Resolve-RegularFile (Join-Path $sdkTools 'lib/apksigner.jar')
$lambdaStubs = Resolve-RegularFile (Join-Path $sdkTools 'core-lambda-stubs.jar')
$prepare = Resolve-RegularFile (Join-Path $PSScriptRoot 'prepare-assets.mjs')
$node = (Get-Command -Name node.exe -CommandType Application | Select-Object -First 1).Source
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Output directory already exists; choose a fresh directory.' }
$null = Resolve-RegularDirectory ([IO.Path]::GetDirectoryName($output))
Test-SigningInputs

$start = [DateTime]::UtcNow.ToString('o')
$stage = Join-Path ([IO.Path]::GetTempPath()) ('fundval-android-release-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $stage
Write-Host "Release staging directory: $stage"
Invoke-Checked $node @($prepare, $site, $stage)

# aapt2's native archive path handling on Windows can fail on a non-ASCII
# workspace. Keep the platform input in the same private staging directory.
$stagedPlatform = Join-Path $stage 'android-platform.jar'
[IO.File]::Copy($platformJar, $stagedPlatform, $false)
if ((Get-FileSha256 $stagedPlatform) -ne (Get-FileSha256 $platformJar)) {
    throw 'Staged platform jar digest mismatch.'
}

$assetEvidencePath = Resolve-RegularFile (Join-Path $stage 'asset-evidence.json')
$assetEvidence = Get-Content -LiteralPath $assetEvidencePath -Encoding UTF8 -Raw | ConvertFrom-Json
$version = [string]$assetEvidence.version
$versionCode = [string]$assetEvidence.versionCode
if ($version -notmatch '^\d+\.\d+\.\d+$' -or $versionCode -notmatch '^[1-9]\d{0,9}$' -or [long]$versionCode -gt 2100000000) {
    throw 'Asset preparation returned invalid release version metadata.'
}
$manifestPath = Resolve-RegularFile (Join-Path $stage 'AndroidManifest.xml')
[xml]$manifest = Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw
$root = $manifest.DocumentElement
$usesSdk = $root.SelectSingleNode('uses-sdk')
if ($root.Name -ne 'manifest' -or $root.GetAttribute('package') -ne $packageId -or
    $root.GetAttribute('versionName', $androidNamespace) -ne $version -or
    $root.GetAttribute('versionCode', $androidNamespace) -ne $versionCode -or
    $null -eq $usesSdk) {
    throw 'Staged Android manifest does not match package and version evidence.'
}
$minSdk = $usesSdk.GetAttribute('minSdkVersion', $androidNamespace)
$targetSdk = $usesSdk.GetAttribute('targetSdkVersion', $androidNamespace)
$application = $root.SelectSingleNode('application')
if ($minSdk -ne '26' -or $targetSdk -ne '35' -or $null -eq $application -or
    $application.GetAttribute('debuggable', $androidNamespace) -notin @('', 'false') -or
    $application.GetAttribute('allowBackup', $androidNamespace) -ne 'false' -or
    $application.GetAttribute('usesCleartextTraffic', $androidNamespace) -ne 'false') {
    throw 'Staged Android manifest does not meet the release SDK/privacy configuration.'
}

$res = Resolve-RegularDirectory (Join-Path $stage 'res')
$assets = Resolve-RegularDirectory (Join-Path $stage 'assets')
$source = Resolve-RegularDirectory (Join-Path $stage 'java')
$generated = (New-Item -ItemType Directory -Path (Join-Path $stage 'generated')).FullName
$classDirectory = (New-Item -ItemType Directory -Path (Join-Path $stage 'classes')).FullName
$dexDirectory = (New-Item -ItemType Directory -Path (Join-Path $stage 'dex')).FullName
$compiled = Join-Path $stage 'compiled-resources.zip'
$unsigned = Join-Path $stage 'unsigned.apk'
$aligned = Join-Path $stage 'aligned.apk'
$apkName = "FundVal-v$version-android-release.apk"
$signed = Join-Path $stage $apkName

Invoke-Checked $aapt2 @('compile', '--dir', $res, '--no-crunch', '-o', $compiled)
Invoke-Checked $aapt2 @('link', '-I', $stagedPlatform, '--manifest', $manifestPath, '--java', $generated,
    '-o', $unsigned, $compiled)
$javaFiles = @(Get-ChildItem -LiteralPath @($source, $generated) -Recurse -File -Filter '*.java' |
    Sort-Object FullName | Select-Object -ExpandProperty FullName)
if ($javaFiles.Count -eq 0) { throw 'No Android Java sources were staged.' }
Invoke-Checked $javac (@('-encoding', 'UTF-8', '-source', '8', '-target', '8', '-bootclasspath', "$stagedPlatform;$lambdaStubs",
    '-d', $classDirectory) + $javaFiles)
$classFiles = @(Get-ChildItem -LiteralPath $classDirectory -Recurse -File -Filter '*.class' |
    Sort-Object FullName | Select-Object -ExpandProperty FullName)
if ($classFiles.Count -eq 0) { throw 'javac produced no Android classes.' }
Invoke-Checked $java (@('-cp', $d8Jar, 'com.android.tools.r8.D8', '--release', '--lib', $stagedPlatform,
    '--min-api', $minSdk, '--output', $dexDirectory) + $classFiles)
$null = Resolve-RegularFile (Join-Path $dexDirectory 'classes.dex')
if (@(Get-ChildItem -LiteralPath $dexDirectory -File -Filter '*.dex').Count -ne 1) {
    throw 'Expected one DEX file for the small native shell.'
}
# Windows aapt2 -A can put backslashes into nested asset paths. The JAR
# archiver uses portable entry names; verify every entry before signing.
Invoke-Checked $jar @('--update', '--file', $unsigned, '-C', $dexDirectory, 'classes.dex', '-C', $stage, 'assets')
Invoke-Checked $zipalign @('-P', '16', '4', $unsigned, $aligned)
$assetCount = Test-WebAssetArchive $aligned $assets
if ($assetCount -ne [int]$assetEvidence.packagedFiles) { throw 'Unexpected prepared asset count.' }

# Inspect before opening the key, so a failed binary/privacy gate does not initialize signing.
$badging = @(Invoke-Checked $aapt @('dump', 'badging', $aligned)) -join "`n"
$identity = "package: name='$packageId' versionCode='$versionCode' versionName='$version'"
if ($badging -notmatch ('(?m)^' + [regex]::Escape($identity) + '(?:\s|$)') -or
    $badging -notmatch "(?m)^sdkVersion:'26'$" -or $badging -notmatch "(?m)^targetSdkVersion:'35'$" -or
    $badging -notmatch ("(?m)^launchable-activity: name='" + [regex]::Escape($packageId + '.MainActivity') + "'") -or
    $badging -match '(?m)^application-debuggable\b') {
    throw 'APK metadata gate rejected the binary manifest or launch activity.'
}
$permissionLines = @(Invoke-Checked $aapt @('dump', 'permissions', $aligned) | Where-Object { $_ -match '^uses-permission' })
if ($permissionLines.Count -ne 1 -or $permissionLines[0] -notmatch "^uses-permission: name='android\.permission\.INTERNET'$" ) {
    throw 'APK permission gate permits INTERNET only.'
}
Write-Utf8File (Join-Path $stage 'apk-badging.txt') ($badging + "`n")

# Passwords never appear in arguments, source control, receipts or command output.
Test-SigningInputs
$previousEnvironment = [Environment]::GetEnvironmentVariable($passwordVariable, 'Process')
$securePassword = $null
$bstr = [IntPtr]::Zero
try {
    if ($InitializeSigning) {
        if (!(Test-Path -LiteralPath $signingParent)) { $null = New-Item -ItemType Directory -Path $signingParent }
        $null = Resolve-RegularDirectory $signingParent
        $null = New-Item -ItemType Directory -Path $signingDirectory
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        $randomBytes = New-Object byte[] 32
        try {
            $random.GetBytes($randomBytes)
            $securePassword = ConvertTo-SecureString ([Convert]::ToBase64String($randomBytes)) -AsPlainText -Force
        } finally {
            [Array]::Clear($randomBytes, 0, $randomBytes.Length)
            $random.Dispose()
        }
        Write-Utf8File $passwordFile (ConvertFrom-SecureString $securePassword)
    } else {
        $securePassword = ConvertTo-SecureString ([IO.File]::ReadAllText($passwordFile, $utf8).Trim())
    }
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    [Environment]::SetEnvironmentVariable($passwordVariable, [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr), 'Process')
    if ($InitializeSigning) {
        Invoke-Checked $keytool @('-genkeypair', '-keystore', $keyStore, '-storetype', 'PKCS12', '-alias', $keyAlias,
            '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=FundVal Android Release',
            '-storepass:env', $passwordVariable, '-keypass:env', $passwordVariable)
    }
    $cert = @(Invoke-Checked $keytool @('-exportcert', '-rfc', '-keystore', $keyStore, '-storetype', 'PKCS12',
        '-alias', $keyAlias, '-storepass:env', $passwordVariable)) -join "`n"
    $pem = [regex]::Match($cert, '(?s)-----BEGIN CERTIFICATE-----(?<data>.*?)-----END CERTIFICATE-----')
    if (!$pem.Success) { throw 'Could not read the public certificate of the release key.' }
    $certBytes = [Convert]::FromBase64String($pem.Groups['data'].Value)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $expectedCert = ([BitConverter]::ToString($hasher.ComputeHash($certBytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    Invoke-Checked $java @('-jar', $signerJar, 'sign', '--ks', $keyStore, '--ks-type', 'PKCS12',
        '--ks-key-alias', $keyAlias, '--ks-pass', "env:$passwordVariable", '--key-pass', "env:$passwordVariable",
        '--v1-signing-enabled', 'false', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true',
        '--v4-signing-enabled', 'false', '--out', $signed, $aligned)
} finally {
    [Environment]::SetEnvironmentVariable($passwordVariable, $previousEnvironment, 'Process')
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ($null -ne $securePassword) { $securePassword.Dispose() }
}

$verify = @(Invoke-Checked $java @('-jar', $signerJar, 'verify', '--verbose', '--print-certs', $signed)) -join "`n"
$certs = [regex]::Matches($verify, '(?m)^Signer #\d+ certificate SHA-256 digest:\s*([a-fA-F0-9]{64})\s*$')
if ($verify -notmatch '(?m)^Verified using v2 scheme .*:\s*true\s*$' -or $certs.Count -ne 1 -or
    $certs[0].Groups[1].Value.ToLowerInvariant() -ne $expectedCert) {
    throw 'APK signature must include v2 and exactly the persistent FundVal signer.'
}
$null = Invoke-Checked $zipalign @('-c', '-P', '16', '4', $signed)
$signedBadging = @(Invoke-Checked $aapt @('dump', 'badging', $signed)) -join "`n"
if ($signedBadging -cne $badging) { throw 'APK metadata changed between alignment and signing.' }
if ((Test-WebAssetArchive $signed $assets) -ne $assetCount) { throw 'Signed APK asset inventory changed.' }

$apkHash = Get-FileSha256 $signed
$receipt = [ordered]@{
    status = 'VERIFIED_SIGNED_RELEASE_APK'
    package = $packageId; version = $version; versionCode = [int]$versionCode
    minSdk = [int]$minSdk; targetSdk = [int]$targetSdk
    apk = $apkName; bytes = (Get-Item -LiteralPath $signed).Length; sha256 = $apkHash
    signerCertificateSha256 = $expectedCert; signatureV2 = $true
    zipAlignmentVerified = $true; packagedWebFilesVerified = $assetCount
    permissions = @('android.permission.INTERNET'); debuggable = $false
    assetEvidenceSha256 = Get-FileSha256 $assetEvidencePath
    startedAtUtc = $start; finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    deviceSmoke = 'NOT_RUN_BY_BUILD_SCRIPT'; externalPublication = 'NOT_RUN_BY_BUILD_SCRIPT'
}
$null = New-Item -ItemType Directory -Path $output
$publishedFile = Join-Path $output $apkName
[IO.File]::Copy($signed, $publishedFile, $false)
if ((Get-FileSha256 $publishedFile) -ne $apkHash) { throw 'Output APK copy digest mismatch.' }
[IO.File]::Copy($assetEvidencePath, (Join-Path $output 'asset-evidence.json'), $false)
Write-Utf8File (Join-Path $output 'apk-badging.txt') ($signedBadging + "`n")
Write-Utf8File (Join-Path $output 'apk-signature.txt') ($verify + "`n")
Write-Utf8File (Join-Path $output 'SHA256SUMS.txt') ("$apkHash  $apkName`n")
Write-Utf8File (Join-Path $output 'build-receipt.json') (($receipt | ConvertTo-Json -Depth 5) + "`n")
Write-Output ($receipt | ConvertTo-Json -Depth 5)
