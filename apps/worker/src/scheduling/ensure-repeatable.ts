import type { Queue } from "bullmq";

export interface RepeatableSpec {
  /** BullMQ job name (also what getRepeatableJobs reports). */
  name: string;
  jobId: string;
  everyMs: number;
  /** Job payload (default {}); the Upload-Post jobs carry their kind here. */
  data?: Record<string, unknown>;
}

/**
 * Idempotently guarantees that a repeatable (interval) job is registered with
 * exactly this interval.
 *
 *  "present"     — already registered with the right interval; nothing changed.
 *  "registered"  — it was missing (first boot, OR Redis lost its state) or had
 *                  a stale interval; it is registered now.
 *
 * Registering only once at boot is not enough: if Redis loses its data while
 * the worker keeps running, every repeatable schedule disappears with it and
 * the periodic work (scheduling reconciliation, analytics and token-refresh
 * scans) silently stops until the next restart — found by wiping Redis under
 * a running stack. The worker therefore calls this on a timer.
 */
export async function ensureRepeatable(queue: Queue, spec: RepeatableSpec): Promise<"present" | "registered"> {
  const mine = (await queue.getRepeatableJobs()).filter((job) => job.name === spec.name);

  let present = false;
  for (const job of mine) {
    if (Number(job.every) === spec.everyMs) {
      present = true;
    } else {
      // A changed interval would otherwise leave the old repeatable running
      // next to the new one (BullMQ keys repeatables by their options).
      await queue.removeRepeatableByKey(job.key);
    }
  }
  if (present) return "present";

  await queue.add(spec.name, spec.data ?? {}, { jobId: spec.jobId, repeat: { every: spec.everyMs }, removeOnComplete: true, removeOnFail: true });
  return "registered";
}
