import { prisma } from "@socialith/database";

export interface TaskFailure {
  code: string;
  message: string;
  /** What the person can do about it, in plain words. */
  remedy?: string;
}

/** What a progress update looks like to the outside (the Redis stream in 5E, the tests). */
export interface TaskUpdate {
  taskId: string;
  organizationId: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  stage: string | null;
  stageDetail: string | null;
  completedUnits: number;
  totalUnits: number | null;
  unit: string | null;
  at: Date;
}

export interface ReporterOptions {
  /** Progress writes closer together than this are merged (the latest wins). Terminal states are always written. */
  minIntervalMs?: number;
  /** Called after every database write: used to push the update to live viewers. Must never throw into the worker. */
  publish?: (update: TaskUpdate) => void | Promise<void>;
  now?: () => Date;
}

const ACTIVE = ["QUEUED", "RUNNING"] as const;

/**
 * Writes one task's progress to the persisted ledger (operation_tasks). BullMQ stays the executor; this is only the
 * record the interface reads, so progress survives page refreshes and worker restarts. It reports what the worker
 * actually measured: units done, units total (or none), the stage, a heartbeat time. It never computes a percentage.
 *
 * Guarantees: a task that already finished is never written to again (a late or duplicate update cannot resurrect it),
 * writes are serialized, and progress writes are throttled so a fast loop does not hammer the database.
 */
export class TaskReporter {
  private lastWriteAt = 0;
  private pending: { completedUnits?: number; stage?: string; stageDetail?: string | null; totalUnits?: number | null; unit?: string | null } | null = null;
  private chain: Promise<void> = Promise.resolve();
  private completed = 0;
  private readonly minIntervalMs: number;
  private readonly now: () => Date;

  constructor(
    readonly taskId: string,
    private readonly options: ReporterOptions = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? 500;
    this.now = options.now ?? (() => new Date());
  }

  get completedUnits(): number {
    return this.completed;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async emit(row: { organizationId: string; status: TaskUpdate["status"]; stage: string | null; stageDetail: string | null; completedUnits: number; totalUnits: number | null; unit: string | null }): Promise<void> {
    if (!this.options.publish) return;
    try {
      await this.options.publish({ taskId: this.taskId, at: this.now(), ...row });
    } catch {
      /* a failed notification must never fail the work; the database already has the truth */
    }
  }

  /** The task starts (or restarts after a retry): RUNNING, attempt counted, start time kept from the first attempt. */
  async start(patch: { stage?: string; stageDetail?: string | null; totalUnits?: number | null; unit?: string | null; completedUnits?: number } = {}): Promise<void> {
    await this.enqueue(async () => {
      const current = await prisma.operationTask.findUnique({ where: { id: this.taskId } });
      if (!current) throw new Error(`Task ${this.taskId} does not exist`);
      if (!(ACTIVE as readonly string[]).includes(current.status)) return; // already finished: never resurrect
      const at = this.now();
      // a restart that cannot resume (a render starts over) says so by resetting the count; a resumable task keeps it
      this.completed = patch.completedUnits ?? current.completedUnits;
      const updated = await prisma.operationTask.update({
        where: { id: this.taskId },
        data: {
          status: "RUNNING",
          startedAt: current.startedAt ?? at,
          lastProgressAt: at,
          attempts: { increment: 1 },
          errorCode: null,
          errorMessage: null,
          errorRemedy: null,
          ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
          ...(patch.stageDetail !== undefined ? { stageDetail: patch.stageDetail } : {}),
          ...(patch.totalUnits !== undefined ? { totalUnits: patch.totalUnits } : {}),
          ...(patch.unit !== undefined ? { unit: patch.unit } : {}),
          ...(patch.completedUnits !== undefined ? { completedUnits: patch.completedUnits } : {}),
        },
      });
      this.lastWriteAt = at.getTime();
      await this.emit(updated);
    });
  }

  /** Records the real total once it is known (e.g. the number of entries found in an archive). null = not measurable. */
  setTotal(totalUnits: number | null, unit?: string): Promise<void> {
    return this.write({ totalUnits, ...(unit !== undefined ? { unit } : {}) }, true);
  }

  /** Records absolute progress. Merged with other updates inside the throttle window. */
  progress(completedUnits: number, stage?: string, stageDetail?: string | null): Promise<void> {
    this.completed = completedUnits;
    return this.write({ completedUnits, ...(stage !== undefined ? { stage } : {}), ...(stageDetail !== undefined ? { stageDetail } : {}) }, false);
  }

  /** Records a stage change without a unit change (indeterminate work: "Probing", "Encoding"). Also refreshes the heartbeat. */
  stage(stage: string, stageDetail?: string | null): Promise<void> {
    return this.write({ stage, ...(stageDetail !== undefined ? { stageDetail } : {}) }, true);
  }

  private write(patch: NonNullable<TaskReporter["pending"]>, force: boolean): Promise<void> {
    this.pending = { ...(this.pending ?? {}), ...patch };
    const due = force || this.now().getTime() - this.lastWriteAt >= this.minIntervalMs;
    if (!due) return Promise.resolve();
    return this.flush();
  }

  /** Writes whatever is pending now. */
  flush(): Promise<void> {
    return this.enqueue(async () => {
      const patch = this.pending;
      if (!patch) return;
      this.pending = null;
      const at = this.now();
      const result = await prisma.operationTask.updateMany({
        where: { id: this.taskId, status: { in: [...ACTIVE] } },
        data: { ...patch, lastProgressAt: at },
      });
      this.lastWriteAt = at.getTime();
      if (result.count === 0) return; // the task finished or was cancelled meanwhile: leave it alone
      const row = await prisma.operationTask.findUnique({ where: { id: this.taskId } });
      if (row) await this.emit(row);
    });
  }

  /** Terminal success. `completedUnits` defaults to the last reported value. */
  async succeed(completedUnits?: number): Promise<void> {
    await this.finish("SUCCEEDED", { completedUnits: completedUnits ?? this.completed, errorCode: null, errorMessage: null, errorRemedy: null, stage: "Done", stageDetail: null });
  }

  /** Terminal failure with a real code and a remedy the person can act on. */
  async fail(failure: TaskFailure): Promise<void> {
    await this.finish("FAILED", { errorCode: failure.code.slice(0, 64), errorMessage: failure.message, errorRemedy: failure.remedy ?? null, stage: "Failed", stageDetail: null });
  }

  /** The person cancelled it. Terminal, like success and failure, and never undone by a late update. */
  async cancel(): Promise<void> {
    await this.finish("CANCELLED", { stage: "Cancelled", stageDetail: null });
  }

  private async finish(status: "SUCCEEDED" | "FAILED" | "CANCELLED", data: Record<string, unknown>): Promise<void> {
    await this.enqueue(async () => {
      this.pending = null;
      const at = this.now();
      const result = await prisma.operationTask.updateMany({
        where: { id: this.taskId, status: { in: [...ACTIVE] } },
        data: { status, finishedAt: at, lastProgressAt: at, ...data },
      });
      this.lastWriteAt = at.getTime();
      if (result.count === 0) return; // already terminal
      const row = await prisma.operationTask.findUnique({ where: { id: this.taskId } });
      if (row) await this.emit(row);
    });
  }
}
