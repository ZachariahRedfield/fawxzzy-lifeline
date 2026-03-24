declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: string): Promise<string>;
  export function writeFile(
    path: string,
    data: string,
    encoding: string,
  ): Promise<void>;
  export function mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<void>;
  export function access(path: string): Promise<void>;
  export function open(
    path: string,
    flags: string,
  ): Promise<{
    fd: number;
    appendFile(data: string): Promise<void>;
    close(): Promise<void>;
  }>;
}

declare module "node:path" {
  const path: {
    resolve: (...paths: string[]) => string;
    dirname: (path: string) => string;
    join: (...paths: string[]) => string;
  };
  export default path;
}

declare module "node:child_process" {
  interface SpawnOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    stdio?:
      | "inherit"
      | "ignore"
      | ["ignore", number, number]
      | ["ignore", "pipe", "pipe"];
    detached?: boolean;
  }

  interface ChildProcess {
    pid?: number;
    stdout: { on(event: "data", listener: (chunk: unknown) => void): void };
    stderr: { on(event: "data", listener: (chunk: unknown) => void): void };
    on(event: "error", listener: (error: Error) => void): void;
    on(
      event: "exit",
      listener: (code: number | null, signal?: string | null) => void,
    ): void;
    on(event: "spawn", listener: () => void): void;
    unref(): void;
  }

  export function spawn(command: string, options?: SpawnOptions): ChildProcess;
  export function spawn(
    command: string,
    args: string[],
    options?: SpawnOptions,
  ): ChildProcess;
}

declare const console: {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

declare const process: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd(): string;
  exitCode?: number;
  platform: string;
  kill(pid: number, signal?: number | string): void;
};

declare function setTimeout(
  callback: (...args: unknown[]) => void,
  delay?: number,
): unknown;
