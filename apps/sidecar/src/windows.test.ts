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

  test("a successfully launched application survives normal command completion", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-launch-"));
    const encoded = Buffer.from("while (!(Test-Path release)) { Start-Sleep -Milliseconds 20 }; Set-Content marker.txt survived", "utf16le").toString("base64");
    let pid: number | undefined;
    try {
      const result = await executeLocalJob(job(`$p = Start-Process -FilePath \"$PSHOME\\powershell.exe\" -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -WorkingDirectory '${root.replaceAll("'", "''")}' -RedirectStandardOutput child.out -RedirectStandardError child.err -PassThru; $p.Id | Set-Content descendant.pid`), root);
      pid = Number(readFileSync(path.join(root, "descendant.pid"), "utf8").trim());
      expect(result).toMatchObject({ ok: true, exitCode: 0 });
      expect(alive(pid)).toBeTrue();
      writeFileSync(path.join(root, "release"), "");
      await until(() => existsSync(path.join(root, "marker.txt")));
      expect(readFileSync(path.join(root, "marker.txt"), "utf8").trim()).toBe("survived");
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);

  for (const trigger of ["cancel", "timeout", "shell-exits-first"] as const) {
    test(`${trigger} kills the root and detached descendants`, async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "sidecar-job-object-"));
      const controller = new AbortController();
      const descendant = "while (!(Test-Path release)) { Start-Sleep -Milliseconds 20 }; Set-Content marker.txt survived";
      const encoded = Buffer.from(descendant, "utf16le").toString("base64");
      const command = `$PID | Set-Content root.pid; $p = Start-Process -FilePath \"$PSHOME\\powershell.exe\" -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -NoNewWindow -PassThru; $p.Id | Set-Content descendant.pid; ${trigger === "shell-exits-first" ? "exit 0" : "Start-Sleep -Seconds 60"}`;
      const signal = trigger === "timeout" ? AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]) : controller.signal;
      const pending = executeLocalJob(job(command), root, signal);
      let rootPid: number | undefined;
      let descendantPid: number | undefined;
      try {
        await until(() => existsSync(path.join(root, "descendant.pid")) && readFileSync(path.join(root, "descendant.pid"), "utf8").trim().length > 0);
        rootPid = Number(readFileSync(path.join(root, "root.pid"), "utf8").trim());
        descendantPid = Number(readFileSync(path.join(root, "descendant.pid"), "utf8").trim());
        expect(Number.isSafeInteger(rootPid)).toBeTrue();
        expect(Number.isSafeInteger(descendantPid)).toBeTrue();
        expect(alive(descendantPid)).toBeTrue();
        if (trigger === "shell-exits-first") await until(() => !alive(rootPid!));
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
