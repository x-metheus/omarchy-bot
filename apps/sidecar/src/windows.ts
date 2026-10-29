import { dlopen, ptr, type Library } from "bun:ffi";
import type { BunFile, Subprocess } from "bun";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { decodePowerShellDiagnostics } from "./windows-output.ts";
import type { LocalExecutor } from "./posix.ts";

const SYMBOLS = {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
    SetInformationJobObject: { args: ["ptr", "u32", "ptr", "u32"], returns: "i32" },
    QueryInformationJobObject: { args: ["ptr", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    GetLongPathNameW: { args: ["ptr", "ptr", "u32"], returns: "u32" },
} as const;

let kernel: Library<typeof SYMBOLS> | undefined;
const BOOTSTRAP = Buffer.from([
  "$ProgressPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "$payload = [Console]::In.ReadLine()",
  "if ($null -eq $payload) { exit 1 }",
  "$script:completion = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))",
  "$command = try { [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($payload)) } catch { Write-Error $_; exit 1 }",
  "$ast = [Management.Automation.Language.Parser]::ParseInput($command, [ref]$null, [ref]$null)",
  // Capture status inside the final execution block; invocation masks nonterminating errors.
  "$block = $ast.EndBlock",
  "if ($null -eq $block) { $block = $ast.ProcessBlock }",
  "if ($null -eq $block) { $block = $ast.BeginBlock }",
  "$trailer = [Environment]::NewLine + @'",
  "$succeeded = $?",
  "$code = 0",
  "if ($LASTEXITCODE) { $code = $LASTEXITCODE } elseif (!$succeeded) { $code = 1 }",
  "[IO.File]::WriteAllText($script:completion, '')",
  "exit $code",
  "'@ + [Environment]::NewLine",
  "if ($null -eq $block) { $command += [Environment]::NewLine + 'end {' + $trailer + '}' }",
  "elseif ($block.Unnamed) { $command += $trailer }",
  "else { $command = $command.Insert($block.Extent.EndOffset - 1, $trailer) }",
  "& ([ScriptBlock]::Create($command))",
  "$succeeded = $?",
  "$code = 0",
  "if ($LASTEXITCODE) { $code = $LASTEXITCODE } elseif (!$succeeded) { $code = 1 }",
  "[IO.File]::WriteAllText($script:completion, '')",
  "exit $code",
].join("\n"), "utf16le").toString("base64");

/** Expand NTFS aliases, retaining missing suffixes for new write destinations. */
export function windowsLongPath(target: string): string {
  const api = (kernel ??= dlopen("kernel32.dll", SYMBOLS)).symbols;
  const missing: string[] = [];
  for (;;) {
    const input = Buffer.from(`${target}\0`, "utf16le");
    const size = api.GetLongPathNameW(ptr(input), null, 0);
    if (size > 0) {
      const output = Buffer.alloc(size * 2);
      const length = api.GetLongPathNameW(ptr(input), ptr(output), size);
      if (length === 0 || length >= size) throw new Error(`GetLongPathNameW failed (Windows error ${api.GetLastError()})`);
      return path.join(output.toString("utf16le", 0, length * 2), ...missing.reverse());
    }
    const error = api.GetLastError();
    const parent = path.dirname(target);
    if ((error !== 2 && error !== 3) || parent === target) throw new Error(`GetLongPathNameW failed (Windows error ${error})`);
    missing.push(path.basename(target));
    target = parent;
  }
}

export const windowsExecutor: LocalExecutor = {
  async run(command, root, signal) {
    signal?.throwIfAborted();
    if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows Local Sidecar requires Windows x64");
    const api = (kernel ??= dlopen("kernel32.dll", SYMBOLS)).symbols;
    const failure = (operation: string): Error => new Error(`${operation} failed (Windows error ${api.GetLastError()})`);
    const job = api.CreateJobObjectW(null, null);
    if (job === null) throw failure("CreateJobObjectW");
    // Windows x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION: 144 bytes; LimitFlags is at offset 16.
    const limits = new Uint8Array(144);
    const flags = new DataView(limits.buffer);
    flags.setUint32(16, 0x2000, true); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    let closed = false;
    const closeJob = (): void => {
      if (closed) return;
      if (!api.CloseHandle(job)) throw failure("CloseHandle(job)");
      closed = true;
    };
    let proc: Subprocess<"pipe", BunFile, BunFile> | undefined;
    let capture: string | undefined;
    try {
      if (!api.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength)) throw failure("SetInformationJobObject");
      capture = mkdtempSync(path.join(os.tmpdir(), "sidecar-windows-"));
      const completion = path.join(capture, "completed");
      const stdoutFile = Bun.file(path.join(capture, "stdout"));
      const stderrFile = Bun.file(path.join(capture, "stderr"));
      const env = { ...process.env };
      delete env.OMARCHY_BOT_DEVICE_TOKEN;
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      proc = Bun.spawn([path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", BOOTSTRAP], {
        cwd: root, env, stdin: "pipe", stdout: stdoutFile, stderr: stderrFile,
      });
      const processHandle = api.OpenProcess(0x0101, 0, proc.pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
      if (processHandle === null) throw failure("OpenProcess");
      try {
        if (!api.AssignProcessToJobObject(job, processHandle)) throw failure("AssignProcessToJobObject");
      } finally {
        api.CloseHandle(processHandle);
      }
      signal?.addEventListener("abort", closeJob, { once: true });
      signal?.throwIfAborted();
      // User code cannot spawn descendants until assignment succeeds and this gate opens.
      proc.stdin.write(`${Buffer.from(command, "utf16le").toString("base64")}\n${Buffer.from(completion, "utf16le").toString("base64")}\n`);
      proc.stdin.end();
      const exitCode = await proc.exited;
      // Explicit exit bypasses normal completion; descendants remain cancellable until the job is empty.
      if (!existsSync(completion)) {
        // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: 48 bytes, ActiveProcesses at offset 40.
        const accounting = new Uint8Array(48);
        const counts = new DataView(accounting.buffer);
        for (;;) {
          signal?.throwIfAborted();
          if (!api.QueryInformationJobObject(job, 1, ptr(accounting), accounting.byteLength, null)) throw failure("QueryInformationJobObject");
          if (counts.getUint32(40, true) === 0) break;
          await Bun.sleep(20);
        }
      }
      const [stdout, rawStderr] = await Promise.all([stdoutFile.text(), stderrFile.text()]);
      const stderr = decodePowerShellDiagnostics(rawStderr);
      signal?.throwIfAborted();
      flags.setUint32(16, 0, true);
      if (!api.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength)) throw failure("SetInformationJobObject(release)");
      return { ok: true, text: `${stdout}${stderr}`.slice(0, 8_192), exitCode };
    } finally {
      signal?.removeEventListener("abort", closeJob);
      try {
        closeJob();
      } finally {
        if (proc !== undefined) {
          if (proc.exitCode === null) proc.kill();
          await proc.exited;
        }
        if (capture !== undefined) rmSync(capture, { recursive: true, force: true });
      }
    }
  },
};
