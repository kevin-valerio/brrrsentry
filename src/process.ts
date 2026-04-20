import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runExecFile(
  file: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });

  return stdout;
}

export async function tryExecFile(
  file: string,
  args: string[],
  cwd: string,
): Promise<string | null> {
  try {
    return await runExecFile(file, args, cwd);
  } catch {
    return null;
  }
}

