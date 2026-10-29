param([Parameter(Mandatory)][ValidateSet('credential','processes','activate','clear-credential')][string]$Action, [string]$Value)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows native smoke requires Windows and PowerShell 7.' }
if ($Action -eq 'activate') { Start-Process -FilePath $Value; exit 0 }
if ($Action -eq 'processes') {
  $processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $Value } | ForEach-Object { $_.ProcessId })
  ConvertTo-Json -InputObject $processes -Compress
  exit 0
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SmokeCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type; public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist, AttributeCount; public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Delete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);
}
'@
$target = 'service-connection.com.omarchy.bot'
if ($Action -eq 'clear-credential') {
  if (-not [SmokeCredential]::Delete($target, 1, 0) -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'Credential cleanup failed' }
  exit 0
}
$pointer = [IntPtr]::Zero
if (-not [SmokeCredential]::Read($target, 1, 0, [ref]$pointer)) {
  if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { 'null'; exit 0 }
  throw 'Credential Manager lookup failed'
}
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][SmokeCredential+Credential])
  $bytes = [byte[]]::new($credential.CredentialBlobSize)
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
  # keyring stores UTF-16LE without a terminator; capture privately, never in evidence logs.
  [Text.Encoding]::Unicode.GetString($bytes)
} finally { [SmokeCredential]::CredFree($pointer) }
