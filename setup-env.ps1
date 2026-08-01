param(
  [string]$SupabaseUrl,
  [string]$SupabaseServiceRoleKey,
  [string]$SupabaseAnonKey,
  [string]$EncryptionKey,
  [string]$DashboardPassword,
  [string]$StorageBucket = 'broadcast-media',
  [int]$HistoryRetentionDays = 30,
  [int]$WaitlistNoReplyHours = 24
)

function Set-UserEnvVar {
  param([string]$Name, [string]$Value)
  if (-not $Value) { return }
  [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
  Write-Host "  Set $Name = ***" -ForegroundColor Green
}

Write-Host "=== saheli dresses WA bot - Secure Environment Setup ===" -ForegroundColor Cyan
Write-Host ""

if (-not $SupabaseUrl) { $SupabaseUrl = Read-Host "Enter Supabase URL (e.g. https://xxx.supabase.co)" }
if (-not $SupabaseServiceRoleKey) { $SupabaseServiceRoleKey = Read-Host "Enter Supabase Service Role Key" }
if (-not $SupabaseAnonKey) { $SupabaseAnonKey = Read-Host "Enter Supabase Anon Key" }
if (-not $EncryptionKey) {
  $EncryptionKey = Read-Host "Enter 32-char encryption key (or press Enter to auto-generate)"
  if (-not $EncryptionKey) {
    $chars = 65..90 + 97..122 + 48..57
    $EncryptionKey = -join ($chars | Get-Random -Count 32 | ForEach-Object { [char]$_ })
    Write-Host "  Generated encryption key: $EncryptionKey" -ForegroundColor Yellow
    Write-Host "  SAVE THIS KEY SECURELY - you will need it to start the bot" -ForegroundColor Yellow
  }
}

Set-UserEnvVar 'SUPABASE_URL' $SupabaseUrl
Set-UserEnvVar 'SUPABASE_SERVICE_ROLE_KEY' $SupabaseServiceRoleKey
Set-UserEnvVar 'SUPABASE_ANON_KEY' $SupabaseAnonKey
Set-UserEnvVar 'ENCRYPTION_KEY' $EncryptionKey
Set-UserEnvVar 'DASHBOARD_PASSWORD' $DashboardPassword
Set-UserEnvVar 'SUPABASE_STORAGE_BUCKET' $StorageBucket
Set-UserEnvVar 'HISTORY_RETENTION_DAYS' "$HistoryRetentionDays"
Set-UserEnvVar 'WAITLIST_NO_REPLY_HOURS' "$WaitlistNoReplyHours"

Write-Host ""
Write-Host "Environment variables set for current user." -ForegroundColor Green
Write-Host "Restart your terminal, then run: node launcher.mjs" -ForegroundColor Green
Write-Host ""
Write-Host "Security notes:" -ForegroundColor Yellow
Write-Host "  - Never commit .env to version control" -ForegroundColor Yellow
Write-Host "  - The service_role key has full admin access - keep it secret" -ForegroundColor Yellow
Write-Host "  - Encryption key protects sensitive data at rest in Supabase" -ForegroundColor Yellow
Write-Host "  - RLS policies restrict data access per user/session" -ForegroundColor Yellow