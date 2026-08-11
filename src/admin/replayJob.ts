import { createDb } from "../db/client.ts";
import { resetFailedJob } from "../db/repositories/jobs.ts";

const jobId = process.argv[2];
const databaseUrl = process.env.DATABASE_URL;

if (!jobId) throw new Error("Usage: pnpm jobs:replay <failed-job-id>");
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const { db, close } = createDb(databaseUrl);
try {
  const reset = await resetFailedJob(db, jobId);
  if (!reset) {
    throw new Error(`Job ${jobId} is not failed or has no retained replay payload`);
  }
  console.log(JSON.stringify({ ok: true, jobId }));
} finally {
  await close();
}
