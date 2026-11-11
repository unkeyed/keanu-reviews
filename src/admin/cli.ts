import { pathToFileURL } from "node:url";
import { type AppContext, createContext } from "#app";
import { loadConfig } from "#config";

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

/** Builds the context a command runs against, after its arguments parse. */
export type OpenContext = () => AppContext;

/**
 * Run a command when its file is the Node entrypoint, against the service's
 * own context, and exit with the code it returns.
 */
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
