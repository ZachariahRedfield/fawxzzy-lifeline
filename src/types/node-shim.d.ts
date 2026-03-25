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
  export function readdir(
    path: string,
    options?: { withFileTypes?: boolean },
  ): Promise<
    Array<
      | string
      | {
          name: string;
          isDirectory(): boolean;
        }
    >
  >;
  export function readlink(path: string): Promise<string>;
}

declare module "node:fs" {
  export function createWriteStream(
    path: string,
    options?: { flags?: string },
  ): {
    write(chunk: string): void;
    end(): void;
  };
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

declare module "node:net" {
  export function createConnection(options: {
    host: string;
    port: number;
  }): {
    once(event: "connect" | "timeout" | "error", listener: () => void): void;
    setTimeout(timeoutMs: number): void;
    destroy(): void;
  };
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
  pid: number;
  execPath: string;
  on(event: "SIGTERM" | "SIGINT", handler: () => void): void;
  kill(pid: number, signal?: number | string): void;
};

declare function setTimeout(
  callback: (...args: unknown[]) => void,
  delay?: number,
): unknown;
