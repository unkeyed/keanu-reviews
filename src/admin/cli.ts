import { pathToFileURL } from "node:url";
import { type AppContext, createContext } from "#app";
import { loadConfig } from "#config";

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export type OpenContext = () => AppContext;

export async function runAsMain(
  moduleUrl: string,
  command: (args: string[], io: CliIo, open: OpenContext) => Promise<number>,
): Promise<void> {
  if (!process.argv[1] || moduleUrl !== pathToFileURL(process.argv[1]).href) return;
  const io: CliIo = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  };
  process.exitCode = await command(process.argv.slice(2), io, () => createContext(loadConfig()));
}
