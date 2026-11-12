import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A modal dialog Premiere is showing (Windows only). */
export interface PremiereDialog {
  hwnd: string;
  title: string;
  text: string;
}

// Persistent PowerShell helper: compiled once, then answers "LIST" and
// "CLOSE <hwnd>" lines on stdin with one JSON line each. Premiere's own modal
// dialogs (AAF Export Log, Translation Report...) are standard #32770 windows
// owned by the main window, so their title and text can be read and they can
// be closed with WM_CLOSE.
const SCRIPT = String.raw`
$ErrorActionPreference = "SilentlyContinue"
$sig = @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class PremDlg {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  static string Txt(IntPtr h) { int n = (int)SendMessage(h, 0x000E, IntPtr.Zero, IntPtr.Zero); if (n <= 0) return ""; var s = new StringBuilder(n + 2); SendMessage(h, 0x000D, (IntPtr)(n + 1), s); return s.ToString(); }
  static string Cls(IntPtr h) { var c = new StringBuilder(256); GetClassName(h, c, 256); return c.ToString(); }
  static string Esc(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ").Replace("\t", " "); }
  public static string List(uint[] pids) {
    var parts = new List<string>();
    var set = new HashSet<uint>(pids);
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (!set.Contains(p) || !IsWindowVisible(h) || Cls(h) != "#32770") return true;
      var texts = new List<string>();
      EnumChildWindows(h, (c, l2) => { var t = Txt(c); if (t.Length > 0 && !t.StartsWith("OS_")) texts.Add(t); return true; }, IntPtr.Zero);
      parts.Add("{\"hwnd\":\"" + h.ToInt64() + "\",\"title\":\"" + Esc(Txt(h)) + "\",\"text\":\"" + Esc(string.Join(" | ", texts)) + "\"}");
      return true;
    }, IntPtr.Zero);
    return "[" + string.Join(",", parts) + "]";
  }
  public static void Close(long h) { PostMessage(new IntPtr(h), 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
"@
Add-Type $sig
[Console]::Out.WriteLine("READY")
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($line -like "CLOSE *") { [PremDlg]::Close([long]$line.Substring(6)); [Console]::Out.WriteLine("[]"); continue }
  $pids = @(Get-Process -Name "Adobe Premiere Pro" -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  if ($pids.Count -eq 0) { [Console]::Out.WriteLine("[]") } else { [Console]::Out.WriteLine([PremDlg]::List($pids)) }
}
`;

/** Progress windows Premiere shows while it works: never an error, never closed. */
export const PROGRESS = [/^(Exporting|Rendering|Importing|Conforming|Analy[sz]ing|Saving|Encoding|Generating|Loading|Indexing|Reading|Building)/i, /Scene Edit Detection/i, /Auto Reframe/i, /Progress/i, /^(Exportando|Renderizando|Importando|Analisando|Salvando|Gerando|Carregando|Codificando|Detec)/i];

/** Titles of Premiere dialogs that are safe to dismiss automatically (informational logs). */
export const AUTO_CLOSE = [/AAF Export Log/i, /Translation Re(port|sults)/i, /Relat[oó]rio de tradu/i, /Log de exporta/i];

export class DialogWatcher {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<boolean> | null = null;
  private buf = "";
  private waiters: ((line: string) => void)[] = [];
  private busy: Promise<unknown> = Promise.resolve();
  readonly supported = process.platform === "win32";

  private start(): Promise<boolean> {
    if (!this.supported) return Promise.resolve(false);
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve) => {
      try {
        const dir = path.join(os.tmpdir(), "premiere-mcp-plus");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "dialogs.ps1");
        fs.writeFileSync(file, SCRIPT, "utf-8");
        const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { windowsHide: true });
        this.proc = p;
        let started = false;
        p.stdout.setEncoding("utf8");
        p.stdout.on("data", (d: string) => {
          this.buf += d;
          let i;
          while ((i = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, i).trim();
            this.buf = this.buf.slice(i + 1);
            if (!started) {
              if (line === "READY") {
                started = true;
                resolve(true);
              }
              continue;
            }
            this.waiters.shift()?.(line);
          }
        });
        const dead = () => {
          this.proc = null;
          this.ready = null;
          for (const w of this.waiters.splice(0)) w("[]");
          if (!started) resolve(false);
        };
        p.on("exit", dead);
        p.on("error", dead);
        setTimeout(() => !started && resolve(false), 20_000);
      } catch {
        resolve(false);
      }
    });
    return this.ready;
  }

  private ask(cmd: string, timeoutMs = 5000): Promise<string> {
    const run = async () => {
      if (!(await this.start()) || !this.proc) return "[]";
      return new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve("[]"), timeoutMs);
        this.waiters.push((line) => {
          clearTimeout(t);
          resolve(line);
        });
        this.proc!.stdin.write(cmd + "\n");
      });
    };
    const p = this.busy.then(run, run);
    this.busy = p.catch(() => undefined);
    return p;
  }

  /** Modal dialogs Premiere is showing right now (empty when none or unsupported). */
  async list(): Promise<PremiereDialog[]> {
    if (!this.supported) return [];
    try {
      return JSON.parse(await this.ask("LIST")) as PremiereDialog[];
    } catch {
      return [];
    }
  }

  async close(d: PremiereDialog): Promise<void> {
    if (this.supported) await this.ask("CLOSE " + d.hwnd);
  }

  /** Warm up the helper so the first check during a call is fast. */
  warm(): void {
    void this.start();
  }

  dispose(): void {
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
  }
}
