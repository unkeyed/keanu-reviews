import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { GITHUB_ROUTES } from "./github/http.ts";
import { SLACK_METHODS } from "./slack/gateway.ts";

const SRC = join(import.meta.dirname);

const SCHEMA_HASH = "2c2b6a0f7f0173517327cf1789df3158cebc7ef9cf78e6021fbf3955de620279";

const SLACK_BASELINE = {
  bot: [
    "chat.delete",
    "chat.postMessage",
    "chat.update",
    "conversations.archive",
    "conversations.create",
    "conversations.info",
    "conversations.invite",
    "conversations.join",
    "conversations.list",
    "conversations.members",
    "conversations.rename",
    "conversations.setTopic",
    "conversations.unarchive",
    "users.info",
    "users.lookupByEmail",
  ],
  user: ["chat.delete", "chat.postMessage", "chat.update", "conversations.leave"],
  oauth: ["oauth.v2.access"],
};

const GITHUB_BASELINE = [
  "GET /repos/{owner}/{repo}/pulls/{number}",
  "GET /repos/{owner}/{repo}/pulls/{number}/reviews",
  "GET /repos/{owner}/{repo}/commits/{sha}/check-runs",
  "GET /repos/{owner}/{repo}/commits/{sha}/pulls",
  "GET /users/{login}",
  "POST /repos/{owner}/{repo}/issues/{number}/comments",
  "POST /app/installations/{installation_id}/access_tokens",
  "GET /user",
  "GET https://github.com/login/oauth/authorize",
  "POST https://github.com/login/oauth/access_token",
];

const SLACK_CLIENT_FILES = ["slack/gateway.ts"];
const GITHUB_POST_FILES = ["github/comments.ts", "github/http.ts", "github/oauth.ts"];
const GITHUB_MINT_FILES = ["github/octokitAuth.ts"];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const sourceFiles = walk(SRC)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("/migrations/"))
  .map((f) => relative(SRC, f))
  .filter((f) => !f.startsWith("testing/"))
  .sort();

const read = (file: string) => readFileSync(join(SRC, file), "utf8");

function literals(file: string): string[] {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text + node.templateSpans.map((s) => `{}${s.literal.text}`).join(""));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function valueImports(file: string): string[] {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((s) =>
    ts.isImportDeclaration(s) &&
    !s.importClause?.isTypeOnly &&
    ts.isStringLiteral(s.moduleSpecifier)
      ? [s.moduleSpecifier.text]
      : [],
  );
}

const SLACK_FAMILY =
  /^(?:admin|apps|auth|bots|chat|conversations|dnd|emoji|files|oauth|pins|reactions|reminders|search|team|usergroups|users|views)\.[a-zA-Z.]+$/;

describe("frozen schema", () => {
  it("keeps src/db/schema.ts and every migration byte-identical", () => {
    const files = ["db/schema.ts", ...walk(join(SRC, "db/migrations")).map((f) => relative(SRC, f))]
      .map((f) => `src/${f}`)
      .sort();
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(`${file}\0`);
      hash.update(readFileSync(join(SRC, "..", file)));
      hash.update("\0");
    }
    expect(hash.digest("hex")).toBe(SCHEMA_HASH);
  });
});

describe("Slack surface", () => {
  it("lists exactly today's methods per credential", () => {
    expect(SLACK_METHODS).toEqual(SLACK_BASELINE);
  });

  it("imports @slack/web-api at runtime only in the client", () => {
    const importers = sourceFiles.filter((f) => valueImports(f).includes("@slack/web-api"));
    expect(importers).toEqual(SLACK_CLIENT_FILES);
  });

  it("calls only listed methods", () => {
    const listed = new Set<string>([
      ...SLACK_METHODS.bot,
      ...SLACK_METHODS.user,
      ...SLACK_METHODS.oauth,
    ]);
    const called = new Set<string>();
    for (const file of SLACK_CLIENT_FILES) {
      for (const m of read(file).matchAll(/\.(conversations|users|chat|oauth)\.(\w+)\(/g)) {
        called.add(`${m[1]}.${m[2]}`);
      }
      for (const text of literals(file)) if (SLACK_FAMILY.test(text)) called.add(text);
    }
    for (const file of sourceFiles) {
      for (const text of literals(file)) {
        const url = /^https:\/\/slack\.com\/api\/([\w.]+)/.exec(text);
        if (url?.[1]) called.add(url[1]);
      }
    }
    expect([...called].filter((m) => !listed.has(m))).toEqual([]);
    expect(called.size).toBeGreaterThan(0);
  });
});

const routePath = (route: string) =>
  (route.split(" ")[1] ?? "")
    .replace("https://api.github.com", "")
    .replace("{owner}/{repo}", "{}")
    .replace(/\{\w+\}/g, "{}");

function githubPath(text: string): string | undefined {
  const path = text.split("?")[0] ?? "";
  if (path.startsWith("{}")) return undefined;
  if (/^\/(?:repos|users|user|app)(?:\/|$)/.test(path)) return path;
  const api = /^https:\/\/api\.github\.com(\/.+)$/.exec(path);
  if (api?.[1] && !api[1].startsWith("{}")) return api[1];
  if (path.startsWith("https://github.com/login/oauth/")) return path;
  return undefined;
}

describe("GitHub surface", () => {
  it("lists exactly today's routes", () => {
    expect([...GITHUB_ROUTES]).toEqual(GITHUB_BASELINE);
  });

  it("requests only listed paths", () => {
    const listed = new Set(GITHUB_ROUTES.map(routePath));
    const used = sourceFiles.flatMap((file) =>
      literals(file).flatMap((text) => {
        const path = githubPath(text);
        return path === undefined ? [] : [{ file, path }];
      }),
    );
    expect(used.filter((u) => !listed.has(u.path))).toEqual([]);
    expect(used.length).toBeGreaterThan(0);
  });

  it("writes only where a POST route is listed", () => {
    const posting = sourceFiles.filter((f) => /githubPostJson\(|method: "POST"/.test(read(f)));
    expect(posting.filter((f) => f.startsWith("github/"))).toEqual(GITHUB_POST_FILES);
  });

  it("mints installation tokens only through @octokit/auth-app in one file", () => {
    const importers = sourceFiles.filter((f) => valueImports(f).includes("@octokit/auth-app"));
    expect(importers).toEqual(GITHUB_MINT_FILES);
  });
});

const BRAND_MINTERS: Record<string, string> = {
  PrId: "pr/store.ts",
  ClientMsgId: "slack/ledger.ts",
  ArrivalKey: "events/arrival.ts",
};

function brandCasts(): string[] {
  const out: string[] = [];
  for (const file of sourceFiles) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        ts.isTypeReferenceNode(node.type) &&
        ts.isIdentifier(node.type.typeName) &&
        Object.hasOwn(BRAND_MINTERS, node.type.typeName.text)
      ) {
        out.push(`${file}: ${node.type.typeName.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

describe("branded ids", () => {
  it("casts to a brand only in its minting file", () => {
    const casts = brandCasts();
    const stray = casts.filter((cast) => {
      const [file, brand] = cast.split(": ");
      return BRAND_MINTERS[brand as string] !== file;
    });
    expect(stray).toEqual([]);
    for (const [brand, minter] of Object.entries(BRAND_MINTERS)) {
      expect(casts, `${minter} mints ${brand}`).toContain(`${minter}: ${brand}`);
    }
  });
});

const LAYERS: readonly (readonly string[])[] = [
  ["lib"],
  ["config", "db"],
  ["events", "github", "slack"],
  ["identity"],
  ["reminders"],
  ["pr"],
  ["mirror", "reviews"],
  ["queue"],
  ["ingest"],
  ["app"],
  ["admin", "index.ts"],
];

const THIRD_PARTY: Record<string, readonly string[]> = {
  "@slack/web-api": ["slack"],
  "@octokit/auth-app": ["github"],
  "@hono/node-server": ["index.ts"],
  hono: ["ingest", "app", "identity", "github"],
  "drizzle-orm": ["db", "pr", "slack", "reminders", "identity", "queue"],
  postgres: ["db"],
  zod: ["config", "events", "github"],
};

const TABLE_OWNERS: Record<string, string> = {
  pullRequests: "pr/store.ts",
  pullRequestLifecycleClaims: "pr/store.ts",
  messages: "slack/ledger.ts",
  reminders: "reminders/store.ts",
  identities: "identity/store.ts",
  githubLinkConfirmations: "identity/store.ts",
  oauthStateNonces: "identity/store.ts",
  slackUserTokens: "identity/store.ts",
  jobs: "queue/store.ts",
  processedDeliveries: "queue/store.ts",
};

const TABLE_READERS: Record<string, string> = {
  "db/readiness.ts": "probes every table's columns with a limit-0 select",
  "reminders/store.ts": "the due scan reads each reminder's PR and reviewer identity in one join",
};

const moduleOf = (file: string) => (file.includes("/") ? (file.split("/")[0] ?? file) : file);
const layerOf = (mod: string) => LAYERS.findIndex((layer) => layer.includes(mod));

interface ImportRef {
  spec: string;
  typeOnly: boolean;
  names: string[];
}

function imports(file: string): ImportRef[] {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((s): ImportRef[] => {
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      const clause = s.importClause;
      const named = clause?.namedBindings;
      const elements = named && ts.isNamedImports(named) ? named.elements : [];
      return [
        {
          spec: s.moduleSpecifier.text,
          typeOnly: Boolean(clause?.isTypeOnly),
          names: elements.filter((e) => !e.isTypeOnly).map((e) => (e.propertyName ?? e.name).text),
        },
      ];
    }
    if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
      return [{ spec: s.moduleSpecifier.text, typeOnly: s.isTypeOnly, names: [] }];
    }
    return [];
  });
}

function layerViolations(): string[] {
  const out: string[] = [];
  for (const file of sourceFiles) {
    const mod = moduleOf(file);
    const text = read(file);
    for (const { spec, typeOnly, names } of imports(file)) {
      let tables: string[] = [];
      if (spec.startsWith(".")) {
        const target = relative(SRC, join(SRC, file, "..", spec));
        if (moduleOf(target) !== mod) out.push(`${file}: relative import across modules (${spec})`);
        if (target === "db/schema.ts") tables = names;
      } else if (spec.startsWith("#")) {
        const targetMod = spec.slice(1);
        const from = layerOf(mod);
        const to = layerOf(targetMod);
        if (!typeOnly && from !== -1 && to >= from && targetMod !== mod) {
          out.push(`${file}: ${mod} (L${from}) imports ${spec} (L${to})`);
        }
        if (spec === "#db") tables = names;
      } else if (!typeOnly) {
        const pkg = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        const allowed = pkg ? THIRD_PARTY[pkg] : undefined;
        if (allowed && !allowed.includes(mod)) out.push(`${file}: imports ${pkg}`);
      }
      for (const name of tables) {
        const owner = TABLE_OWNERS[name];
        if (owner && owner !== file && !TABLE_READERS[file]) {
          out.push(`${file}: uses table ${name} owned by ${owner}`);
        }
      }
    }
    if (layerOf(mod) === -1) out.push(`${file}: not in a layered module`);
    if (text.includes("process.env") && file !== "config/env.ts") {
      out.push(`${file}: reads process.env`);
    }
    if (/process\.on\(/.test(text) && file !== "index.ts") {
      out.push(`${file}: installs process handlers`);
    }
  }
  return out;
}

describe("module layering", () => {
  it("has no violations", () => {
    expect(layerViolations()).toEqual([]);
  });
});
