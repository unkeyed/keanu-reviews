import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type Config, ConfigError, loadConfig } from "../config.ts";
import { createDb } from "../db/client.ts";
import { createInstallationAuth } from "../github/auth.ts";
import { octokitMintFn } from "../github/octokitAuth.ts";
import { createGithubUserFetcher } from "../github/users.ts";
import {
  type ImportResult,
  type ImportRow,
  type LinkDeps,
  importIdentities,
} from "../identity/link.ts";
import { createWebApiSlackClient } from "../slack/webApiClient.ts";

const MAX_IMPORT_BYTES = 1_048_576;
const MAX_IMPORT_ROWS = 10_000;
const ALLOWED_COLUMNS = ["github_login", "slack_email", "slack_user_id"] as const;
const ALLOWED_COLUMN_SET = new Set<string>(ALLOWED_COLUMNS);
const USAGE = "Usage: pnpm admin:import-identities -- <identities.csv|identities.json>";

export class IdentityImportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityImportInputError";
  }
}

function parseCsvRecords(input: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;

  const finishField = () => {
    record.push(field);
    field = "";
    afterQuote = false;
  };
  const finishRecord = () => {
    finishField();
    if (record.some((value) => value.length > 0)) records.push(record);
    record = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (afterQuote && char !== "," && char !== "\n" && char !== "\r") {
      throw new IdentityImportInputError("CSV has characters after a closing quote");
    }
    if (char === '"') {
      if (field.length > 0) {
        throw new IdentityImportInputError("CSV quote must begin at the start of a field");
      }
      quoted = true;
    } else if (char === ",") {
      finishField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      finishRecord();
    } else {
      field += char;
    }
  }

  if (quoted) throw new IdentityImportInputError("CSV has an unterminated quoted field");
  if (field.length > 0 || record.length > 0) finishRecord();
  return records;
}

function readImportRow(value: unknown, rowNumber: number): ImportRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IdentityImportInputError(`row ${rowNumber} must be an object`);
  }

  const input = value as Record<string, unknown>;
  const unknownColumns = Object.keys(input).filter((key) => !ALLOWED_COLUMN_SET.has(key));
  if (unknownColumns.length > 0) {
    throw new IdentityImportInputError(
      `row ${rowNumber} has unsupported field(s): ${unknownColumns.join(", ")}`,
    );
  }

  const row: ImportRow = {};
  for (const column of ALLOWED_COLUMNS) {
    const raw = input[column];
    if (raw === undefined || raw === "") continue;
    if (typeof raw !== "string") {
      throw new IdentityImportInputError(`row ${rowNumber} field ${column} must be a string`);
    }
    const normalized = raw.trim();
    if (normalized) row[column] = normalized;
  }
  return row;
}

function enforceRowLimit(rows: ImportRow[]): ImportRow[] {
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new IdentityImportInputError(`import exceeds the ${MAX_IMPORT_ROWS} row limit`);
  }
  return rows;
}

export function parseIdentityImport(contents: string, format: ".csv" | ".json"): ImportRow[] {
  if (contents.includes("\0")) throw new IdentityImportInputError("input contains a null byte");

  if (format === ".json") {
    let decoded: unknown;
    try {
      decoded = JSON.parse(contents);
    } catch {
      throw new IdentityImportInputError("input is not valid JSON");
    }
    if (!Array.isArray(decoded)) {
      throw new IdentityImportInputError("JSON input must be an array of identity objects");
    }
    return enforceRowLimit(decoded.map((row, index) => readImportRow(row, index + 1)));
  }

  const records = parseCsvRecords(contents.replace(/^\uFEFF/, ""));
  const header = records.shift()?.map((column) => column.trim());
  if (!header || header.length === 0) {
    throw new IdentityImportInputError("CSV input must have a header row");
  }
  if (new Set(header).size !== header.length) {
    throw new IdentityImportInputError("CSV header contains duplicate columns");
  }
  const unknownColumns = header.filter((column) => !ALLOWED_COLUMN_SET.has(column));
  if (unknownColumns.length > 0) {
    throw new IdentityImportInputError(
      `CSV header has unsupported column(s): ${unknownColumns.join(", ")}`,
    );
  }
  if (!header.includes("github_login")) {
    throw new IdentityImportInputError("CSV header must include github_login");
  }

  const rows = records.map((values, index) => {
    if (values.length !== header.length) {
      throw new IdentityImportInputError(
        `CSV row ${index + 2} has ${values.length} fields; expected ${header.length}`,
      );
    }
    return readImportRow(
      Object.fromEntries(header.map((column, i) => [column, values[i]])),
      index + 2,
    );
  });
  return enforceRowLimit(rows);
}

export async function loadIdentityImport(fileName: string): Promise<ImportRow[]> {
  const filePath = resolve(fileName);
  const extension = extname(filePath).toLowerCase();
  if (extension !== ".csv" && extension !== ".json") {
    throw new IdentityImportInputError("input file must use a .csv or .json extension");
  }

  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new IdentityImportInputError("input path must be a regular file");
  if (metadata.size > MAX_IMPORT_BYTES) {
    throw new IdentityImportInputError(`input exceeds the ${MAX_IMPORT_BYTES} byte limit`);
  }

  return parseIdentityImport(await readFile(filePath, "utf8"), extension);
}

interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

interface IdentityImportRuntime {
  deps: LinkDeps;
  close: () => Promise<void>;
}

interface IdentityImportCliServices {
  loadRows(fileName: string): Promise<ImportRow[]>;
  createRuntime(config: Config): IdentityImportRuntime | Promise<IdentityImportRuntime>;
  importRows(deps: LinkDeps, rows: ImportRow[]): Promise<ImportResult>;
}

function productionImportDependencies(config: Config): IdentityImportRuntime {
  const auth = createInstallationAuth(
    octokitMintFn(config.GITHUB_APP_ID, config.GITHUB_APP_PRIVATE_KEY),
  );
  const slack = createWebApiSlackClient(config.SLACK_BOT_TOKEN);
  // Create the cleanup-bearing resource last so any dependency-construction
  // failure before this point cannot strand an open database pool.
  const database = createDb(config.DATABASE_URL);
  return {
    deps: {
      db: database.db,
      slack,
      fetchGithubUser: createGithubUserFetcher(auth, config.GITHUB_INSTALLATION_ID),
    },
    close: database.close,
  };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof ConfigError || error instanceof IdentityImportInputError)
    return error.message;
  return "an operational error occurred; earlier rows may have been applied and the import can be rerun";
}

export async function runIdentityImportCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  },
  serviceOverrides: Partial<IdentityImportCliServices> = {},
): Promise<number> {
  // pnpm forwards the conventional option separator to this Node entrypoint.
  const positionalArgs = args[0] === "--" ? args.slice(1) : args;
  if (positionalArgs.length === 1 && positionalArgs[0] === "--help") {
    io.stdout(USAGE);
    return 0;
  }
  if (positionalArgs.length !== 1) {
    io.stderr(USAGE);
    return 2;
  }

  let close: (() => Promise<void>) | undefined;
  try {
    const loadRows = serviceOverrides.loadRows ?? loadIdentityImport;
    const createRuntime = serviceOverrides.createRuntime ?? productionImportDependencies;
    const importRows = serviceOverrides.importRows ?? importIdentities;
    const rows = await loadRows(positionalArgs[0] as string);
    const runtime = await createRuntime(loadConfig(env));
    close = runtime.close;
    const result = await importRows(runtime.deps, rows);
    const skippedByReason = Object.fromEntries(
      [...new Set(result.skipped.map(({ reason }) => reason))].map((reason) => [
        reason,
        result.skipped.filter((skipped) => skipped.reason === reason).length,
      ]),
    );
    io.stdout(
      JSON.stringify({
        imported: result.imported,
        skipped: result.skipped.length,
        skippedByReason,
      }),
    );
    return 0;
  } catch (error) {
    io.stderr(`Identity import failed: ${safeErrorMessage(error)}`);
    return 1;
  } finally {
    await close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runIdentityImportCli(process.argv.slice(2));
}
