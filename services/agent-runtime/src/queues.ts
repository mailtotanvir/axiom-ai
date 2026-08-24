/**
 * BullMQ queue topology (ADR 0003). Phase 3 fills in processors; Phase 0
 * establishes the names, concurrency defaults, and connection factory so
 * every later epic shares one substrate.
 */

import { Queue, Worker, type ConnectionOptions } from "bullmq";

export const QUEUE_NAMES = {
  agentExec: "agent-exec",
  toolExec: "tool-exec",
  webhookDelivery: "webhook-delivery",
  webhookDeadLetter: "webhook-dlq",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export function createConnection(url: string): ConnectionOptions {
  return { url };
}

const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: false,
} as const;

export interface RuntimeQueues {
  agentExec: Queue;
  toolExec: Queue;
  webhookDelivery: Queue;
  webhookDeadLetter: Queue;
  close: () => Promise<void>;
}

export function createQueues(redisUrl: string): RuntimeQueues {
  const connection = createConnection(redisUrl);
  const mk = (name: QueueName) =>
    new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });

  const queues: RuntimeQueues = {
    agentExec: mk(QUEUE_NAMES.agentExec),
    toolExec: mk(QUEUE_NAMES.toolExec),
    webhookDelivery: mk(QUEUE_NAMES.webhookDelivery),
    webhookDeadLetter: mk(QUEUE_NAMES.webhookDeadLetter),
    close: async () => {
      await Promise.all([
        queues.agentExec.close(),
        queues.toolExec.close(),
        queues.webhookDelivery.close(),
        queues.webhookDeadLetter.close(),
      ]);
    },
  };
  return queues;
}

/** Placeholder processor; replaced by the sandbox executor in Phase 3 (A3). */
export function createWorkerStub(
  name: QueueName,
  redisUrl: string,
  onJob: (jobId: string, name: string) => Promise<void>,
): Worker {
  return new Worker(
    name,
    async (job) => {
      await onJob(job.id ?? "unknown", job.name);
    },
    { connection: createConnection(redisUrl), concurrency: 4 },
  );
}
