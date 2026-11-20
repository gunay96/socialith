import { prisma } from "@socialith/database";
import type { OperationTask, Prisma } from "@socialith/database";
import { computeProgress } from "@socialith/studio";
import type { SafeUser } from "../types/auth.js";
import { notFound } from "./media-common.js";

type Db = Prisma.TransactionClient | typeof prisma;

export interface NewTask {
  organizationId: string;
  type: string;
  subjectType?: string;
  subjectId?: string;
  parentTaskId?: string | null;
  queueName?: string;
  createdById?: string | null;
  stage?: string;
  totalUnits?: number | null;
  unit?: string;
}

/** A task starts QUEUED with no progress; the worker is the only thing that moves it forward. */
export function createTask(db: Db, input: NewTask): Promise<OperationTask> {
  return db.operationTask.create({
    data: {
      organizationId: input.organizationId,
      type: input.type,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      queueName: input.queueName ?? null,
      createdById: input.createdById ?? null,
      stage: input.stage ?? "Queued",
      totalUnits: input.totalUnits ?? null,
      unit: input.unit ?? null,
    },
  });
}

/**
 * What the interface may see of a task. `progress` comes from @socialith/studio's computeProgress: a percentage appears only
 * when the worker recorded a real total, otherwise the task is indeterminate. Nothing is estimated here.
 */
export function taskDto(t: OperationTask, now: Date = new Date()) {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    stage: t.stage,
    stageDetail: t.stageDetail,
    unit: t.unit,
    subject: t.subjectType && t.subjectId ? { type: t.subjectType, id: t.subjectId } : null,
    parentTaskId: t.parentTaskId,
    attempts: t.attempts,
    error: t.errorCode ? { code: t.errorCode, message: t.errorMessage, remedy: t.errorRemedy } : null,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    lastProgressAt: t.lastProgressAt,
    progress: computeProgress(t, now),
  };
}
export type TaskDto = ReturnType<typeof taskDto>;

export interface ListTasksQuery {
  state: "active" | "finished" | "all";
  type?: string;
  subjectType?: string;
  subjectId?: string;
  limit: number;
}

export async function listTasks(actor: SafeUser, q: ListTasksQuery) {
  const where: Prisma.OperationTaskWhereInput = {
    organizationId: actor.organizationId,
    ...(q.state === "active" ? { status: { in: ["QUEUED", "RUNNING"] } } : q.state === "finished" ? { status: { in: ["SUCCEEDED", "FAILED", "CANCELLED"] } } : {}),
    ...(q.type ? { type: q.type } : {}),
    ...(q.subjectType ? { subjectType: q.subjectType } : {}),
    ...(q.subjectId ? { subjectId: q.subjectId } : {}),
  };
  const [rows, active] = await Promise.all([
    prisma.operationTask.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: q.limit }),
    prisma.operationTask.count({ where: { organizationId: actor.organizationId, status: { in: ["QUEUED", "RUNNING"] } } }),
  ]);
  const now = new Date();
  return { items: rows.map((r) => taskDto(r, now)), activeCount: active, generatedAt: now };
}

export async function getTask(actor: SafeUser, id: string) {
  const row = await prisma.operationTask.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!row) throw notFound("Task");
  return taskDto(row);
}
