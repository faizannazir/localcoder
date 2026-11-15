import { execFileSync } from "child_process";

/** Resident memory of a process in MB via `ps` (Linux and macOS). Returns null where unavailable (e.g. Windows). */
export function readRssMb(pid: number | undefined): number | null {
  if (!pid) return null;
  try {
    const kb = parseInt(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), 10);
    return Number.isNaN(kb) ? null : Math.round((kb / 1024) * 10) / 10;
  } catch { return null; }
}
