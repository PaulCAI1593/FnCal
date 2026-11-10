$ErrorActionPreference = 'Stop'
$root = 'H:\Agent\Server\DSH\bot\projects\CalDAV'
$md = Get-Content -LiteralPath (Join-Path $root 'code\M5-0.7.12-最终冻结表.md') -Encoding UTF8
$rows = @()
foreach ($line in $md) {
  if ($line -match '^\|\s*`([^`]+)`(?:（新）)?\s*\|\s*([\d,]+)\s*\|\s*`([0-9A-F]{64})`\s*\|\s*(\d)\s*\|\s*$') {
    $rows += [pscustomobject]@{
      Path  = $matches[1]
      Bytes = [int64]($matches[2] -replace ',', '')
      Sha   = $matches[3]
      CR    = [int]$matches[4]
    }
  }
}
"rows=$($rows.Count)"
$bad = 0
foreach ($r in $rows) {
  $p = Join-Path $root ($r.Path -replace '/', '\')
  if (-not (Test-Path -LiteralPath $p)) { "MISSING $($r.Path)"; $bad++; continue }
  $b = [System.IO.File]::ReadAllBytes($p)
  $h = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
  $cr = @($b -eq 13).Count
  $ok = ($b.Length -eq $r.Bytes) -and ($h -eq $r.Sha) -and ($cr -eq $r.CR)
  if ($ok) { "OK   $($r.Path)  $($b.Length)" } else { "FAIL $($r.Path)  bytes=$($b.Length)/$($r.Bytes)  sha=$h  cr=$cr/$($r.CR)"; $bad++ }
}
"bad=$bad"
