import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";

export const redisConnection = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

export interface IngestJobData {
  document_id: string;
}

export const ingestQueue = new Queue<IngestJobData>("deepconsol-ingest", {
  connection: redisConnection,
});

export async function enqueueIngest(document_id: string, opts?: JobsOptions): Promise<void> {
  await ingestQueue.add(
    "ingest",
    { document_id },
    {
      removeOnComplete: { count: 1000, age: 3600 * 24 },
      removeOnFail: { count: 1000 },
      attempts: 2,
      backoff: { type: "exponential", delay: 30_000 },
      ...opts,
    }
  );
}
