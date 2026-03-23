declare module "node:fs/promises" {
  export function readFile(path: string, encoding: string): Promise<string>;
}

declare const console: {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

declare const process: {
  argv: string[];
  exitCode?: number;
};
