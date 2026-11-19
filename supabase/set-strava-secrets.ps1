# Stores the Strava API credentials as Supabase function secrets.
# The secret is typed hidden and goes straight to Supabase: it is never written to disk or to Git.
$ErrorActionPreference = 'Stop'
$project = 'xhhpvelvjkcdihggxiqt'

$id = (Read-Host 'Strava Client ID (the number on strava.com/settings/api)').Trim()
if ($id -notmatch '^\d{3,10}$') { Write-Host 'That does not look like a Strava Client ID (digits only).' -ForegroundColor Red; exit 1 }

$sec = Read-Host 'Strava Client Secret (input hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if ($plain -notmatch '^[0-9a-f]{40}$') { Write-Host 'That does not look like a Strava Client Secret (40 hex characters). Nothing was saved.' -ForegroundColor Red; exit 1 }

npx --yes supabase@latest secrets set --project-ref $project "STRAVA_CLIENT_ID=$id" "STRAVA_CLIENT_SECRET=$plain" "ALLOWED_ORIGINS=https://folfure.github.io"
$plain = $null
if ($LASTEXITCODE -eq 0) { Write-Host "`nStrava credentials saved in Supabase." -ForegroundColor Green } else { Write-Host 'Saving failed (see above).' -ForegroundColor Red }
