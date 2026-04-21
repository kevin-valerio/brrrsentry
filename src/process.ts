import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SpawnStreamingResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export function spawnStreaming(
  file: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    onLine?: (line: string) => void;
  },
): { child: ChildProcessWithoutNullStreams; completion: Promise<SpawnStreamingResult> } {
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "pipe",
  });

  const handleStream = (stream: NodeJS.ReadableStream) => {
    let buffered = "";
    stream.on("data", (chunk) => {
      buffered += chunk.toString();
      const parts = buffered.split(/\r?\n/);
      buffered = parts.pop() ?? "";
      for (const line of parts) {
        options.onLine?.(line);
      }
    });
    stream.on("end", () => {
      const finalLine = buffered.trimEnd();
      if (finalLine.length > 0) {
        options.onLine?.(finalLine);
      }
    });
  };

  handleStream(child.stdout);
  handleStream(child.stderr);

  const completion = new Promise<SpawnStreamingResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });

  return { child, completion };
}

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
