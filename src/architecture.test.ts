import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { GITHUB_ROUTES } from "./github/http.ts";
import { SLACK_METHODS } from "./slack/gateway.ts";

const SRC = join(import.meta.dirname);

/** Installs never relink, so the schema and every migration stay byte-identical. */
const SCHEMA_HASH = "2c2b6a0f7f0173517327cf1789df3158cebc7ef9cf78e6021fbf3955de620279";

/** Today's Slack surface. Growing it can need a new scope; shrinking it is fine. */
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

/** Today's GitHub surface. Growing it can need a new App permission. */
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

/** Every string and template literal, substitutions written as `{}`. Comments are skipped. */
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

/** Specifiers this file imports at runtime (type-only imports carry no surface). */
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

/** A GitHub request path or URL as written in source, or undefined for any other literal. */
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

/**
 * Target layering from the rewrite design. Report mode lists what still
 * breaks it; S2 turns ENFORCE on once every module has its index.ts.
 */
const ENFORCE_LAYERS = false;

const LAYERS: readonly (readonly string[])[] = [
  ["lib"],
  ["config", "db"],
  ["events", "github", "slack"],
  ["identity"],
  ["reminders"],
  ["pr"],
  ["mirror", "reviews"],
  ["queue", "ingest"],
  ["app"],
  ["admin", "main.ts"],
];

const THIRD_PARTY: Record<string, readonly string[]> = {
  "@slack/web-api": ["slack"],
  "@octokit/auth-app": ["github"],
  hono: ["ingest", "app", "identity", "github"],
  "drizzle-orm": ["db", "pr", "slack", "reminders", "identity", "queue"],
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

const moduleOf = (file: string) => (file.includes("/") ? (file.split("/")[0] ?? file) : file);
const layerOf = (mod: string) => LAYERS.findIndex((layer) => layer.includes(mod));

function resolveRelative(from: string, spec: string): string {
  return relative(SRC, join(SRC, from, "..", spec));
}

function layerViolations(): string[] {
  const out: string[] = [];
  for (const file of sourceFiles) {
    const mod = moduleOf(file);
    const text = read(file);
    for (const spec of valueImports(file)) {
      if (spec.startsWith(".")) {
        const target = resolveRelative(file, spec);
        const targetMod = moduleOf(target);
        if (targetMod !== mod) out.push(`${file}: relative import across modules (${spec})`);
        if (targetMod === "db" && target === "db/schema.ts") {
          const names = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${spec}"`).exec(text);
          for (const raw of names?.[1]?.split(",") ?? []) {
            const name = raw.replace(/^\s*type\s+/, "").trim();
            const owner = TABLE_OWNERS[name];
            if (owner && owner !== file) out.push(`${file}: uses table ${name} owned by ${owner}`);
          }
        }
        continue;
      }
      if (spec.startsWith("#")) {
        const targetMod = spec.slice(1);
        const from = layerOf(mod);
        const to = layerOf(targetMod);
        if (from !== -1 && to !== -1 && to >= from && targetMod !== mod) {
          out.push(`${file}: ${mod} (L${from}) imports ${spec} (L${to})`);
        }
        continue;
      }
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      const allowed = pkg ? THIRD_PARTY[pkg] : undefined;
      if (allowed && !allowed.includes(mod)) out.push(`${file}: imports ${pkg}`);
    }
    if (layerOf(mod) === -1) out.push(`${file}: not in a layered module`);
    if (text.includes("process.env") && file !== "config/env.ts") {
      out.push(`${file}: reads process.env`);
    }
    if (/process\.on\(/.test(text) && file !== "main.ts")
      out.push(`${file}: installs process handlers`);
  }
  return out;
}

describe("module layering", () => {
  it(ENFORCE_LAYERS ? "has no violations" : "reports violations (report-only until S2)", () => {
    const violations = layerViolations();
    if (ENFORCE_LAYERS) expect(violations).toEqual([]);
    else if (violations.length > 0) {
      console.info(`architecture: ${violations.length} layer violations\n${violations.join("\n")}`);
    }
  });
});
