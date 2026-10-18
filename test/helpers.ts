import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "commons-test-"));
  dirs.push(d);
  return d;
}
export function cleanupTempDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
