import { copyFile, readFile, rename, writeFile } from "node:fs/promises";

// Writes to the same file are serialized through this chain so two concurrent
// handlers can never interleave and tear the JSON on disk.
const writeChains = new Map<string, Promise<unknown>>();

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function tryReadBackup<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(`${filePath}.bak`, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Read and parse a JSON state file without ever silently destroying data.
 * - Missing file (ENOENT) -> null: caller starts empty, nothing is written yet.
 * - Valid JSON -> the parsed value.
 * - Corrupt JSON -> recover from `<file>.bak` if possible; otherwise preserve the
 *   broken file as `<file>.corrupt-<timestamp>` and return null. The original
 *   bytes are kept for manual recovery, never overwritten with empty state.
 * - Any other read error (lock, I/O) -> rethrow, so a transient failure fails
 *   loudly instead of resetting the store to empty.
 */
export async function readJsonState<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    const recovered = await tryReadBackup<T>(filePath);
    if (recovered !== null) {
      console.error(`[persistence] ${filePath} is corrupt, recovered from ${filePath}.bak.`);
      return recovered;
    }
    const preserved = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await rename(filePath, preserved).catch(() => undefined);
    console.error(`[persistence] ${filePath} is corrupt and no usable backup exists. Preserved as ${preserved}, starting with empty state.`);
    return null;
  }
}

/**
 * Atomically persist JSON state: write a temp file, back up the current file to
 * `<file>.bak`, then atomically rename the temp over the target (rename is atomic
 * on the same filesystem, so the target is always a complete file). Writes to the
 * same path are serialized, so concurrent saves cannot interleave.
 */
export function writeJsonStateAtomic(filePath: string, data: unknown): Promise<void> {
  const run = async () => {
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, serialized, "utf8");
    await copyFile(filePath, `${filePath}.bak`).catch((error) => {
      // First write has no existing file to back up; any other backup failure
      // must not block the primary write.
      if (isErrnoException(error) && error.code === "ENOENT") return;
      console.error(`[persistence] backup of ${filePath} failed`, error);
    });
    await rename(tmpPath, filePath);
  };

  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const next = previous.then(run, run);
  // Keep the chain alive even if a write rejects, so one failure does not poison
  // later writes; the returned promise still surfaces the error to the caller.
  writeChains.set(filePath, next.catch(() => undefined));
  return next;
}

/** Wait for all in-flight store writes to finish (used on graceful shutdown). */
export async function flushPendingWrites(): Promise<void> {
  await Promise.allSettled([...writeChains.values()]);
}
