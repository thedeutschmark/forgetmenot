/**
 * Console window visibility — Windows-only hide/show for the runtime's
 * attached console window.
 *
 * Why this exists: the runtime exe launches with a visible console window
 * by default (because it's a Node SEA binary). When the operator wants
 * quiet-background behavior they toggle `showTerminal: false` in the
 * toolkit; the runtime reads that at startup and hides its own window.
 *
 * Why a spawned helper: the exe can't link native Win32 APIs directly
 * without a C++ addon. Spawning a short-lived PowerShell that P/Invokes
 * AttachConsole + ShowWindow keeps the SEA distribution envelope clean
 * (no extra bundled binaries). The spawn itself takes ~300ms and runs
 * exactly once at startup.
 *
 * How it finds the right window: a new child process has no console of
 * its own. It calls AttachConsole(parentPid) to attach to the runtime's
 * console, then GetConsoleWindow() to get that console's HWND, then
 * ShowWindow(hwnd, SW_HIDE=0) to hide it. The window stays hidden even
 * after the helper exits — the runtime keeps owning it.
 *
 * No-op on macOS/Linux — on those platforms the exe either runs detached
 * or the operator started it from a terminal they're already attached to;
 * forcibly hiding would break the second case.
 */

import { spawn } from "node:child_process";

export function hideConsoleWindowIfRequested(showTerminal: boolean): void {
  if (showTerminal) return;
  if (process.platform !== "win32") return;

  const parentPid = process.pid;
  const ps = [
    "Add-Type -Name W -Namespace Native -MemberDefinition '",
    "[System.Runtime.InteropServices.DllImport(\"kernel32.dll\")]",
    "public static extern bool AttachConsole(int dwProcessId);",
    "[System.Runtime.InteropServices.DllImport(\"kernel32.dll\")]",
    "public static extern bool FreeConsole();",
    "[System.Runtime.InteropServices.DllImport(\"kernel32.dll\")]",
    "public static extern System.IntPtr GetConsoleWindow();",
    "[System.Runtime.InteropServices.DllImport(\"user32.dll\")]",
    "public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);';",
    "[Native.W]::FreeConsole() | Out-Null;",
    `[Native.W]::AttachConsole(${parentPid}) | Out-Null;`,
    "$h = [Native.W]::GetConsoleWindow();",
    "if ($h -ne [System.IntPtr]::Zero) { [Native.W]::ShowWindow($h, 0) | Out-Null }",
  ].join(" ");

  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.unref();
  } catch (err) {
    console.warn("[console-visibility] Failed to hide console:", err instanceof Error ? err.message : err);
  }
}
