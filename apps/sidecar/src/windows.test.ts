import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { executeLocalJob } from "./execute.ts";

const job = (command: string) => ({ type: "local.job" as const, jobId: "windows", action: "run" as const, hostname: "windows", botId: "bot", turnId: "turn", command });

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// Real OS children cannot advance with fake timers; poll witnessed process/file state.
async function until(probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error("Windows process condition never became true");
    await Bun.sleep(20);
  }
}

async function removeLaunchFixture(root: string, snapshot: (phase: string) => Promise<void>, io = {
  remove: () => rmSync(root, { recursive: true, force: true }),
  now: () => performance.now(),
  // Real Windows file locks must clear on the OS clock; fake timers cannot release them.
  sleep: (ms: number) => Bun.sleep(ms),
  report: (line: string) => console.error(line),
}): Promise<void> {
  const started = io.now();
  let attempts = 0;
  let delay = 100;
  let original: unknown;
  const lockError = (error: unknown) => `${String(error)} code=${error instanceof Error && "code" in error ? String(error.code) : "unknown"}`;
  const diagnose = async (phase: string) => {
    try { await snapshot(phase); }
    catch (error) { io.report(`[windows-launch-cleanup] diagnostic-error phase=${phase} error=${String(error)}`); }
  };
  for (;;) {
    attempts++;
    try {
      io.remove();
      if (attempts > 1) io.report(`[windows-launch-cleanup] success root=${JSON.stringify(root)} attempts=${attempts} elapsedMs=${Math.round(io.now() - started)} budgetMs=10000`);
      return;
    } catch (error) {
      if (attempts === 1) {
        original = error;
        io.report(`[windows-launch-cleanup] first-failure root=${JSON.stringify(root)} attempts=1 elapsedMs=${Math.round(io.now() - started)} error=${lockError(error)}`);
        await diagnose("first-rm-failure");
      }
      const remaining = 10_000 - (io.now() - started);
      if (remaining <= 0) {
        await diagnose("terminal-rm-failure");
        io.report(`[windows-launch-cleanup] terminal-failure root=${JSON.stringify(root)} attempts=${attempts} elapsedMs=${Math.round(io.now() - started)} budgetMs=10000 lastError=${lockError(error)}`);
        throw original;
      }
      const sleepMs = Math.min(delay, remaining);
      io.report(`[windows-launch-cleanup] retry attempts=${attempts} elapsedMs=${Math.round(io.now() - started)} delayMs=${Math.round(sleepMs)} error=${lockError(error)}`);
      await io.sleep(sleepMs);
      delay = Math.min(delay * 2, 1_000);
    }
  }
}

function launchProcessSnapshot(root: string, seeds: number[]) {
  const observed = new Set(seeds.filter(pid => Number.isSafeInteger(pid) && pid > 0));
  return async (phase: string): Promise<void> => {
    // Retain witnessed descendants so a vanished intermediate parent cannot hide them later.
    const script = [
      "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
      `$seeds = @(${[...observed].join(",")})`,
      "$all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 1 | Select-Object ProcessId,ParentProcessId,Name,CommandLine)",
      "$seen = @{}; foreach ($seed in $seeds) { $seen[[string]$seed] = $true }",
      "do { $changed = $false; foreach ($item in $all) { if ($seen.ContainsKey([string]$item.ParentProcessId) -and !$seen.ContainsKey([string]$item.ProcessId)) { $seen[[string]$item.ProcessId] = $true; $changed = $true } } } while ($changed)",
      "$matched = @($all | Where-Object { $seen.ContainsKey([string]$_.ProcessId) })",
      "ConvertTo-Json -InputObject $matched -Compress -Depth 3",
    ].join("\n");
    const result = spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      cwd: os.tmpdir(), encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true,
    });
    const label = `[windows-launch-cleanup] snapshot phase=${phase} root=${JSON.stringify(root)} rootPid=${seeds[0] ?? "unknown"} childPid=${seeds[1] ?? "unknown"} chainSeeds=${JSON.stringify([...observed])}`;
    if (result.error || result.status !== 0) throw new Error(`${label} queryTimeoutMs=2000 error=${String(result.error ?? result.status)} stderr=${result.stderr}`);
    const processes: { ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null }[] = JSON.parse(result.stdout);
    for (const item of processes) observed.add(item.ProcessId);
    console.error(`${label} processes=${JSON.stringify(processes)} note=${phase === "before-command-completion" ? "launched child expected alive; root may already have exited" : phase === "before-pid-kill" ? "before test cleanup kills known PIDs" : "after known PID exit waits; remaining descendants are unexpected; ancestry is not proof of an open file handle"}`);
  };
}

describe.skipIf(process.platform !== "win32")("Windows LocalExecutor", () => {
  test("runs PowerShell 5.1 syntax, Unicode output and an explicit exit code without leaking the device token", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-powershell-"));
    const previousToken = process.env.OMARCHY_BOT_DEVICE_TOKEN;
    process.env.OMARCHY_BOT_DEVICE_TOKEN = "executor-test-secret";
    try {
      const result = await executeLocalJob(job("Write-Output $PSVersionTable.PSVersion.ToString(); Write-Output 'sentinel-λ'; if ($env:OMARCHY_BOT_DEVICE_TOKEN) { Write-Output 'leaked-token' }; exit 7"), root);
      expect(result).toMatchObject({ ok: true, exitCode: 7 });
      if (!result.ok) throw new Error(result.error);
      expect(result.text).toMatch(/^5\.1\./);
      expect(result.text).toContain("sentinel-λ");
      expect(result.text).not.toContain("leaked-token");
      const native = await executeLocalJob(job("cmd.exe /c exit 9"), root);
      expect(native).toMatchObject({ ok: true, exitCode: 9 });
      const truncated = await executeLocalJob(job("Write-Output ('x' * 9000)"), root);
      if (!truncated.ok) throw new Error(truncated.error);
      expect(truncated.text).toHaveLength(8_192);
    } finally {
      if (previousToken === undefined) delete process.env.OMARCHY_BOT_DEVICE_TOKEN;
      else process.env.OMARCHY_BOT_DEVICE_TOKEN = previousToken;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns readable warning and error streams from encoded PowerShell", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-powershell-streams-"));
    try {
      const result = await executeLocalJob(job("Write-Warning 'warning <sentinel> & λ'; Write-Error 'error <sentinel> & λ'"), root);
      expect(result).toMatchObject({ ok: true, exitCode: 1 });
      if (!result.ok) throw new Error(result.error);
      expect(result.text).toContain("warning <sentinel> & λ");
      expect(result.text).toContain("error <sentinel> & λ");
      expect(result.text).not.toContain("#< CLIXML");
      expect(result.text).not.toContain("<Objs");
      expect(result.text).not.toContain("_x000D_");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports script failures without masking them behind successful native commands", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-powershell-status-"));
    try {
      for (const command of ["Get-SidecarMissingSentinelCommand", "cmd.exe /c exit 0; Write-Error 'native-success-then-error'", "throw 'terminating-sentinel'"]) {
        expect(await executeLocalJob(job(command), root)).toMatchObject({ ok: true, exitCode: 1 });
      }
      expect(await executeLocalJob(job("cmd.exe /c exit 9; Write-Error 'native-error-then-error'"), root)).toMatchObject({ ok: true, exitCode: 9 });
      expect(await executeLocalJob(job("cmd.exe /c exit 9; return"), root)).toMatchObject({ ok: true, exitCode: 9 });
      expect(await executeLocalJob(job("cmd.exe /c exit 9; exit 7"), root)).toMatchObject({ ok: true, exitCode: 7 });
      expect(await executeLocalJob(job("Write-Error 'recovered'; Write-Output 'success'"), root)).toMatchObject({ ok: true, exitCode: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a user completion variable cannot overwrite an existing file", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-completion-scope-"));
    const report = path.join(root, "report.txt");
    writeFileSync(report, "existing report must survive\n");
    try {
      const result = await executeLocalJob(job("$completion = Join-Path (Get-Location).Path 'report.txt'; Write-Output done"), root);
      expect(result).toMatchObject({ ok: true, exitCode: 0 });
      if (!result.ok) throw new Error(result.error);
      expect(result.text.trim()).toBe("done");
      expect(readFileSync(report, "utf8")).toBe("existing report must survive\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("top-level named blocks preserve PowerShell execution and final status", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-named-blocks-"));
    try {
      for (const [command, text, exitCode] of [
        ["end { Write-Output 'done' }", "done", 0],
        ["begin { Write-Output 'begin' } process { Write-Output 'process' } end { Write-Output 'end' }", "begin\r\nprocess\r\nend", 0],
        ["begin { Write-Output 'begin-only' }", "begin-only", 0],
        ["process { Write-Output 'process-only' }", "process-only", 0],
        ["dynamicparam { }", "", 0],
        ["#requires -Version 5.1\nparam([string]$name = 'λ')\nend { Write-Output $name # a closing brace } in a comment\n} # trailing comment", "λ", 0],
        ["end { Write-Error 'named-error' }", "named-error", 1],
        ["begin { cmd.exe /c exit 0 } process { Write-Error 'named-after-native-success' }", "named-after-native-success", 1],
        ["process { cmd.exe /c exit 9; Write-Error 'named-native-nine' }", "named-native-nine", 9],
        ["end { Write-Output 'early'; return; Write-Output 'unreachable' }", "early", 0],
        ["end { Write-Output 'explicit'; exit 7 }", "explicit", 7],
      ] as const) {
        const result = await executeLocalJob(job(command), root);
        expect(result).toMatchObject({ ok: true, exitCode });
        if (!result.ok) throw new Error(result.error);
        if (command.includes("Write-Error")) expect(result.text).toContain(text);
        else expect(result.text.trim()).toBe(text);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  test.each(["ordinary", "shadowed-completion", "named-end", "early-return"] as const)("a successfully launched application survives %s command completion", async (form) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-launch-"));
    const report = path.join(root, "report.txt");
    writeFileSync(report, "existing report must survive\n");
    const encoded = Buffer.from("$PID | Set-Content child-ready.pid; while (!(Test-Path release)) { Start-Sleep -Milliseconds 20 }; Set-Content marker.txt survived", "utf16le").toString("base64");
    const controller = new AbortController();
    let rootPid: number | undefined;
    let pid: number | undefined;
    let snapshot: ((phase: string) => Promise<void>) | undefined;
    let completed = false;
    const launch = `$PID | Set-Content root.pid; $p = Start-Process -FilePath "$PSHOME\\powershell.exe" -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -WorkingDirectory '${root.replaceAll("'", "''")}' -RedirectStandardOutput child.out -RedirectStandardError child.err -PassThru; $p.Id | Set-Content descendant.pid; Write-Output launch-complete`;
    const command = form === "named-end" ? `end { ${launch} }`
      : form === "shadowed-completion" ? `$completion = Join-Path (Get-Location).Path 'report.txt'; ${launch}`
      : form === "early-return" ? `${launch}; return` : launch;
    const pending = executeLocalJob(job(command), root, controller.signal).then(result => { completed = true; return result; });
    try {
      await until(() => existsSync(path.join(root, "child-ready.pid")) && existsSync(path.join(root, "descendant.pid")) && readFileSync(path.join(root, "descendant.pid"), "utf8").trim().length > 0);
      rootPid = Number(readFileSync(path.join(root, "root.pid"), "utf8").trim());
      pid = Number(readFileSync(path.join(root, "descendant.pid"), "utf8").trim());
      expect(Number.isSafeInteger(rootPid)).toBeTrue();
      expect(Number.isSafeInteger(pid)).toBeTrue();
      snapshot = launchProcessSnapshot(root, [rootPid, pid]);
      try { await snapshot("before-command-completion"); }
      catch (error) { console.error(`[windows-launch-cleanup] diagnostic-error ${String(error)}`); }
      try {
        await until(() => !alive(rootPid!) && completed);
      } catch {
        throw new Error(`Launched-child completion blocked: rootAlive=${alive(rootPid)}, childAlive=${alive(pid)}, resultCompleted=${completed}, childReady=${existsSync(path.join(root, "child-ready.pid"))}`);
      }
      const result = await pending;
      expect(result).toMatchObject({ ok: true, exitCode: 0 });
      if (!result.ok) throw new Error(result.error);
      expect(result.text.trim()).toBe("launch-complete");
      expect(alive(pid)).toBeTrue();
      expect(readFileSync(report, "utf8")).toBe("existing report must survive\n");
      writeFileSync(path.join(root, "release"), "");
      await until(() => existsSync(path.join(root, "marker.txt")));
      expect(readFileSync(path.join(root, "marker.txt"), "utf8").trim()).toBe("survived");
    } finally {
      const knownPids = ["root.pid", "descendant.pid", "child-ready.pid"].map(file => existsSync(path.join(root, file)) ? Number(readFileSync(path.join(root, file), "utf8").trim()) : 0);
      rootPid ??= knownPids[0];
      pid ??= knownPids[1];
      snapshot ??= launchProcessSnapshot(root, [rootPid ?? 0, pid ?? 0, ...knownPids]);
      try { await snapshot("before-pid-kill"); }
      catch (error) { console.error(`[windows-launch-cleanup] diagnostic-error ${String(error)}`); }
      controller.abort();
      for (const knownPid of new Set(knownPids)) {
        if (!Number.isSafeInteger(knownPid) || knownPid <= 0) continue;
        if (alive(knownPid)) {
          try { process.kill(knownPid, "SIGKILL"); } catch { /* already gone */ }
        }
        await until(() => !alive(knownPid));
      }
      await pending;
      await removeLaunchFixture(root, snapshot);
    }
  }, 60_000);

  for (const trigger of ["cancel", "timeout", "shell-exits-first"] as const) {
    test(`${trigger} kills the root and detached descendants`, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-job-object-"));
      const controller = new AbortController();
      const descendant = "while (!(Test-Path release)) { Start-Sleep -Milliseconds 20 }; Set-Content marker.txt survived";
      const encoded = Buffer.from(descendant, "utf16le").toString("base64");
      const command = `$PID | Set-Content root.pid; $p = Start-Process -FilePath \"$PSHOME\\powershell.exe\" -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -NoNewWindow -PassThru; $p.Id | Set-Content descendant.pid; ${trigger === "shell-exits-first" ? "exit 0" : "Start-Sleep -Seconds 60"}`;
      const signal = trigger === "timeout" ? AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) : controller.signal;
      let completed = false;
      const pending = executeLocalJob(job(command), root, signal).then(result => { completed = true; return result; });
      let rootPid: number | undefined;
      let descendantPid: number | undefined;
      try {
        await until(() => existsSync(path.join(root, "descendant.pid")) && readFileSync(path.join(root, "descendant.pid"), "utf8").trim().length > 0);
        rootPid = Number(readFileSync(path.join(root, "root.pid"), "utf8").trim());
        descendantPid = Number(readFileSync(path.join(root, "descendant.pid"), "utf8").trim());
        expect(Number.isSafeInteger(rootPid)).toBeTrue();
        expect(Number.isSafeInteger(descendantPid)).toBeTrue();
        expect(alive(descendantPid)).toBeTrue();
        if (trigger === "shell-exits-first") {
          await until(() => !alive(rootPid!));
          expect(completed).toBeFalse();
          expect(alive(descendantPid)).toBeTrue();
        }
        if (trigger !== "timeout") controller.abort();
        expect((await pending).ok).toBeFalse();
        await until(() => !alive(rootPid!) && !alive(descendantPid!));
        writeFileSync(path.join(root, "release"), "");
        expect(existsSync(path.join(root, "marker.txt"))).toBeFalse();
      } finally {
        controller.abort();
        await pending;
        for (const pid of [rootPid, descendantPid]) {
          if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
        }
        rmSync(root, { recursive: true, force: true });
      }
    }, 25_000);
  }
});
