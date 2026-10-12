import { createHash } from "node:crypto";
import type { Store } from "../../store";
import { createActivityService } from "../activity/service";
import { inspectImageBytes } from "../conversations/images";
import type {
  ArchivedAttachment,
  ConversationGenerationResult,
  ConversationSnapshot,
} from "../conversations/service";

export type ImageJobStatus =
  | "queued"
  | "submitting"
  | "running"
  | "recovery"
  | "ready"
  | "sending"
  | "sent"
  | "failed"
  | "unknown";

export interface ImageToolInvocation {
  call: { id: string; name: string; arguments: string };
  completion?: Omit<ConversationGenerationResult, "text"> & { text?: string };
}

export interface ImageJobInput {
  id?: string;
  turnId: string;
  toolCallId: string;
  framing: "selfie" | "full_body";
  sceneTags: string[];
  prompt: string;
  workflow: Record<string, unknown>;
  seed: number;
  promptId?: string;
  invocation?: ImageToolInvocation;
}

export interface ImageJob extends Omit<ImageJobInput, "id" | "promptId" | "invocation"> {
  id: string;
  promptId: string;
  submittedPromptId: string | null;
  invocation: ImageToolInvocation | null;
  chatId: string;
  inputMessageId: string;
  status: ImageJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  deadlineAt: string | null;
  failureCode: string | null;
  assetId: string | null;
  deliveryAttempts: number;
  nextAttemptAt: string | null;
  telegramMessageId: string | null;
  deliveredAt: string | null;
}

export interface GeneratedImage extends ArchivedAttachment {
  jobId: string;
  turnId: string;
  chatId: string;
  createdAt: string;
}

export interface ImageDelivery {
  id: string;
  turnId: string;
  chatId: string;
  inputMessageId: string;
  assetId: string;
  attempts: number;
  image: GeneratedImage;
}

export interface ImageFailureNotice {
  id: string;
  job: ImageJob;
  snapshot: ConversationSnapshot;
  chatId: string;
  inputMessageId: string;
  text: string | null;
  status: "pending" | "generating" | "ready" | "sending" | "sent" | "failed" | "unknown";
  failureCode: string | null;
  telegramMessageId: string | null;
  result: ConversationGenerationResult | null;
}

export interface ImageFailureNoticeDelivery extends ImageFailureNotice {
  text: string;
}

type JobRow = Omit<ImageJob, "workflow" | "sceneTags" | "invocation"> & {
  workflowJson: string;
  sceneTagsJson: string;
  invocationJson: string | null;
};

const columns = `j.id, j.turn_id AS turnId, t.chat_id AS chatId,
  t.message_id AS inputMessageId, j.tool_call_id AS toolCallId,
  j.invocation_json AS invocationJson, j.framing, j.scene_tags_json AS sceneTagsJson,
  j.prompt, j.workflow_json AS workflowJson, j.seed, j.prompt_id AS promptId,
  j.submitted_prompt_id AS submittedPromptId, j.status, j.created_at AS createdAt,
  j.updated_at AS updatedAt, j.started_at AS startedAt, j.deadline_at AS deadlineAt,
  j.failure_code AS failureCode, a.id AS assetId, j.delivery_attempts AS deliveryAttempts,
  j.next_attempt_at AS nextAttemptAt, j.telegram_message_id AS telegramMessageId,
  j.delivered_at AS deliveredAt`;
const tables = `core_image_jobs j JOIN core_conversation_turns t ON t.id = j.turn_id
  LEFT JOIN core_generated_images a ON a.job_id = j.id`;

function fromRow(row: JobRow): ImageJob {
  const { workflowJson, sceneTagsJson, invocationJson, ...rest } = row;
  return {
    ...rest,
    workflow: JSON.parse(workflowJson),
    sceneTags: JSON.parse(sceneTagsJson),
    invocation: invocationJson === null ? null : JSON.parse(invocationJson),
  };
}

function validateUuid(value: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))
    throw new TypeError("Image request IDs must be canonical UUIDs.");
}

function validateCode(code: string): void {
  if (!/^[a-z0-9_]{1,80}$/.test(code)) throw new TypeError("Invalid image failure code.");
}

function serializeResult(result?: ConversationGenerationResult): string | null {
  if (!result) return null;
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > 64 * 1024)
    throw new TypeError("Image notification result exceeds its storage limit.");
  return json;
}

/** Owns the durable render and delivery boundary; network work belongs to the server. */
export function createImageJobService(
  store: Store,
  options: { now?: () => Date; renderTimeoutMs?: number } = {},
) {
  const { db } = store;
  const activity = createActivityService(store);
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const renderTimeoutMs = options.renderTimeoutMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(renderTimeoutMs) || renderTimeoutMs < 1000)
    throw new TypeError("Image render deadline must be at least one second.");

  const get = (id: string): ImageJob | null => {
    const row = db
      .query<JobRow, [string]>(`SELECT ${columns} FROM ${tables} WHERE j.id = ?`)
      .get(id);
    return row ? fromRow(row) : null;
  };
  const getForTurn = (turnId: string): ImageJob | null => {
    const row = db
      .query<JobRow, [string]>(`SELECT ${columns} FROM ${tables} WHERE j.turn_id = ?`)
      .get(turnId);
    return row ? fromRow(row) : null;
  };
  const requireJob = (id: string, states?: ImageJobStatus[]): ImageJob => {
    const job = get(id);
    if (!job) throw new Error("Image job does not exist.");
    if (states && !states.includes(job.status))
      throw new Error("Image job is not in the required state.");
    return job;
  };
  const log = (job: ImageJob, summary: string, failed = false) =>
    activity.append({
      kind: "image_generation",
      summary,
      status: failed ? "failed" : "succeeded",
      metadata: {
        jobId: job.id,
        turnId: job.turnId,
        status: job.status,
        failureCode: job.failureCode,
        assetId: job.assetId,
        telegramMessageId: job.telegramMessageId,
      },
    });
  const getImage = (assetId: string): GeneratedImage | null =>
    db
      .query<GeneratedImage, [string]>(`SELECT a.id, a.job_id AS jobId, j.turn_id AS turnId,
        t.chat_id AS chatId, a.original_bytes AS bytes, a.mime_type AS mimeType,
        a.width, a.height, a.byte_size AS byteSize, a.sha256, a.created_at AS createdAt
        FROM core_generated_images a JOIN core_image_jobs j ON j.id = a.job_id
        JOIN core_conversation_turns t ON t.id = j.turn_id WHERE a.id = ?`)
      .get(assetId) ?? null;
  const queueFailureNotice = (id: string) => {
    const timestamp = now();
    db.query(`INSERT OR IGNORE INTO core_image_failure_notices(job_id,status,created_at,updated_at)
      VALUES (?,'pending',?,?)`).run(id, timestamp, timestamp);
  };
  const getFailureNotice = (id: string): ImageFailureNotice | null => {
    const row = db
      .query<
        {
          text: string | null;
          status: ImageFailureNotice["status"];
          failureCode: string | null;
          telegramMessageId: string | null;
          snapshotJson: string;
          resultJson: string | null;
        },
        [string]
      >(`SELECT n.text,n.status,n.failure_code AS failureCode,
        n.telegram_message_id AS telegramMessageId,t.snapshot_json AS snapshotJson,n.result_json AS resultJson
      FROM core_image_failure_notices n JOIN core_image_jobs j ON j.id=n.job_id
      JOIN core_conversation_turns t ON t.id=j.turn_id WHERE n.job_id=?`)
      .get(id);
    if (!row) return null;
    const { snapshotJson, resultJson, ...notice } = row;
    const job = requireJob(id);
    return {
      ...notice,
      id,
      job,
      chatId: job.chatId,
      inputMessageId: job.inputMessageId,
      snapshot: JSON.parse(snapshotJson) as ConversationSnapshot,
      result: resultJson === null ? null : JSON.parse(resultJson),
    };
  };
  const requireNotice = (id: string, status: ImageFailureNotice["status"]): ImageFailureNotice => {
    const notice = getFailureNotice(id);
    if (!notice || notice.status !== status)
      throw new Error("Image failure notice is not in the required state.");
    return notice;
  };

  return {
    get,
    getForTurn,
    getImage,
    getFailureNotice,
    listForTurn(turnId: string): ImageJob[] {
      const job = getForTurn(turnId);
      return job ? [job] : [];
    },
    recentJobs(limit = 50): ImageJob[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
        throw new TypeError("Image job limit must be between 1 and 200.");
      return db
        .query<JobRow, [number]>(`SELECT ${columns} FROM ${tables} ORDER BY j.rowid DESC LIMIT ?`)
        .all(limit)
        .map(fromRow);
    },
    enqueue(input: ImageJobInput): ImageJob {
      return db
        .transaction(() => {
          // The originating turn, rather than provider-generated call IDs, owns deduplication.
          const existing = getForTurn(input.turnId);
          if (existing) return existing;
          const turn = db
            .query<{ status: string }, [string]>(
              "SELECT status FROM core_conversation_turns WHERE id = ?",
            )
            .get(input.turnId);
          if (turn?.status !== "generating")
            throw new Error("An image request requires an active originating conversation turn.");
          const id = input.id ?? crypto.randomUUID();
          const promptId = input.promptId ?? crypto.randomUUID();
          validateUuid(id);
          validateUuid(promptId);
          if (!input.toolCallId || input.toolCallId.length > 200)
            throw new TypeError("An image tool call ID is required.");
          if (!["selfie", "full_body"].includes(input.framing))
            throw new TypeError("Invalid image framing.");
          if (
            !Array.isArray(input.sceneTags) ||
            input.sceneTags.length > 12 ||
            input.sceneTags.some(
              (tag) => typeof tag !== "string" || !tag.trim() || tag.length > 100,
            )
          )
            throw new TypeError("Image scenes must have at most 12 short tags.");
          if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff)
            throw new TypeError("Image seeds must be unsigned 32-bit integers.");
          if (typeof input.prompt !== "string" || !input.prompt || input.prompt.length > 8192)
            throw new TypeError("An image prompt of at most 8192 characters is required.");
          if (
            !input.workflow ||
            typeof input.workflow !== "object" ||
            Array.isArray(input.workflow)
          )
            throw new TypeError("An image workflow object is required.");
          const workflowJson = JSON.stringify(input.workflow);
          const invocationJson = input.invocation ? JSON.stringify(input.invocation) : null;
          if (
            Buffer.byteLength(workflowJson) > 256 * 1024 ||
            (invocationJson !== null && Buffer.byteLength(invocationJson) > 64 * 1024)
          )
            throw new TypeError("Image request data exceeds its storage limit.");
          if (input.invocation && input.invocation.call.id !== input.toolCallId)
            throw new TypeError("Image invocation must match its tool call ID.");
          const timestamp = now();
          db.query(`INSERT INTO core_image_jobs(id,turn_id,tool_call_id,invocation_json,framing,
          scene_tags_json,prompt,workflow_json,seed,prompt_id,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,'queued',?,?)`).run(
            id,
            input.turnId,
            input.toolCallId,
            invocationJson,
            input.framing,
            JSON.stringify(input.sceneTags),
            input.prompt,
            workflowJson,
            input.seed,
            promptId,
            timestamp,
            timestamp,
          );
          const job = requireJob(id);
          log(job, "Character image request queued.");
          return job;
        })
        .immediate();
    },
    /** Existing active work takes priority, including an uncertain submission. */
    nextPendingRender(): ImageJob | null {
      const row = db
        .query<JobRow, []>(`SELECT ${columns} FROM ${tables}
        WHERE j.status IN ('queued','submitting','running','recovery')
        ORDER BY CASE WHEN j.status = 'queued' THEN 1 ELSE 0 END, j.rowid LIMIT 1`)
        .get();
      return row ? fromRow(row) : null;
    },
    claimRender(): ImageJob | null {
      return db
        .transaction(() => {
          if (
            db
              .query(`SELECT id FROM core_image_jobs
          WHERE status IN ('submitting','running','recovery') LIMIT 1`)
              .get()
          )
            return null;
          const row = db
            .query<{ id: string }, []>(`SELECT id FROM core_image_jobs
          WHERE status = 'queued' ORDER BY rowid LIMIT 1`)
            .get();
          if (!row) return null;
          const startedAt = now();
          db.query(`UPDATE core_image_jobs SET status='submitting',started_at=?,deadline_at=?,
          updated_at=? WHERE id=? AND status='queued'`).run(
            startedAt,
            new Date(Date.parse(startedAt) + renderTimeoutMs).toISOString(),
            startedAt,
            row.id,
          );
          return requireJob(row.id);
        })
        .immediate();
    },
    markSubmitted(id: string, promptId: string): ImageJob {
      validateUuid(promptId);
      return db
        .transaction(() => {
          const job = requireJob(id, ["submitting", "running", "recovery"]);
          const mismatch = job.promptId !== promptId;
          db.query(`UPDATE core_image_jobs SET submitted_prompt_id=?,status=?,failure_code=?,
          updated_at=? WHERE id=?`).run(
            promptId,
            mismatch ? "recovery" : "running",
            mismatch ? "prompt_id_mismatch" : null,
            now(),
            id,
          );
          return requireJob(id);
        })
        .immediate();
    },
    markRecovery(id: string, code: string): ImageJob {
      validateCode(code);
      return db
        .transaction(() => {
          requireJob(id, ["submitting", "running", "recovery"]);
          db.query(
            "UPDATE core_image_jobs SET status='recovery',failure_code=?,updated_at=? WHERE id=?",
          ).run(code, now(), id);
          return requireJob(id);
        })
        .immediate();
    },
    fail(id: string, code: string, outcome: { unknown?: boolean } = {}): ImageJob {
      validateCode(code);
      return db
        .transaction(() => {
          requireJob(id, ["queued", "submitting", "running", "recovery"]);
          db.query(
            "UPDATE core_image_jobs SET status=?,failure_code=?,updated_at=? WHERE id=?",
          ).run(outcome.unknown ? "unknown" : "failed", code, now(), id);
          const job = requireJob(id);
          log(
            job,
            outcome.unknown
              ? "Character image render outcome is unknown."
              : "Character image generation failed.",
            true,
          );
          queueFailureNotice(id);
          return job;
        })
        .immediate();
    },
    saveImage(id: string, bytes: Uint8Array): GeneratedImage {
      const metadata = inspectImageBytes(bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return db
        .transaction(() => {
          const job = requireJob(id);
          if (job.assetId) {
            const existing = getImage(job.assetId);
            if (!existing || existing.sha256 !== sha256)
              throw new Error("A different image is already archived for this request.");
            return existing;
          }
          requireJob(id, ["submitting", "running", "recovery"]);
          const assetId = crypto.randomUUID();
          const timestamp = now();
          db.query(`INSERT INTO core_generated_images(id,job_id,original_bytes,mime_type,width,height,
          byte_size,sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
            assetId,
            id,
            bytes,
            metadata.mimeType,
            metadata.width,
            metadata.height,
            bytes.length,
            sha256,
            timestamp,
          );
          db.query(
            "UPDATE core_image_jobs SET status='ready',failure_code=NULL,updated_at=? WHERE id=?",
          ).run(timestamp, id);
          log(requireJob(id), "Generated character image archived; awaiting delivery.");
          const asset = getImage(assetId);
          if (!asset) throw new Error("Generated image was not archived.");
          return asset;
        })
        .immediate();
    },
    claimDelivery(): ImageDelivery | null {
      return db
        .transaction(() => {
          if (db.query("SELECT id FROM core_image_jobs WHERE status='sending' LIMIT 1").get())
            return null;
          const timestamp = now();
          // Finish the acknowledgement first. A terminal text failure must not strand a requested photo.
          const row = db
            .query<JobRow, [string]>(`SELECT ${columns} FROM ${tables}
          WHERE j.status='ready' AND t.status IN ('delivered','failed','unknown')
            AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?)
          ORDER BY j.rowid LIMIT 1`)
            .get(timestamp);
          if (!row?.assetId) return null;
          const image = getImage(row.assetId);
          if (!image) throw new Error("Image delivery has no archived bytes.");
          db.query(`UPDATE core_image_jobs SET status='sending',delivery_attempts=delivery_attempts+1,
          updated_at=?,next_attempt_at=NULL WHERE id=?`).run(timestamp, row.id);
          return {
            id: row.id,
            turnId: row.turnId,
            chatId: row.chatId,
            inputMessageId: row.inputMessageId,
            assetId: row.assetId,
            attempts: row.deliveryAttempts + 1,
            image,
          };
        })
        .immediate();
    },
    recordDelivery(
      id: string,
      result:
        | { status: "sent"; messageId: string }
        | { status: "retry"; code: string; retryAt: string }
        | { status: "failed" | "unknown"; code: string },
    ): ImageJob {
      if (result.status === "sent") {
        if (!/^[0-9]{1,30}$/.test(result.messageId))
          throw new TypeError("Invalid Telegram photo receipt.");
      } else {
        validateCode(result.code);
        if (
          result.status === "retry" &&
          (!Number.isFinite(Date.parse(result.retryAt)) ||
            new Date(result.retryAt).toISOString() !== result.retryAt)
        )
          throw new TypeError("Image delivery retry time must be a canonical timestamp.");
      }
      return db
        .transaction(() => {
          requireJob(id, ["sending"]);
          const timestamp = now();
          db.query(`UPDATE core_image_jobs SET status=?,failure_code=?,next_attempt_at=?,
          telegram_message_id=?,delivered_at=?,updated_at=? WHERE id=?`).run(
            result.status === "retry" ? "ready" : result.status,
            result.status === "sent" ? null : result.code,
            result.status === "retry" ? result.retryAt : null,
            result.status === "sent" ? result.messageId : null,
            result.status === "sent" ? timestamp : null,
            timestamp,
            id,
          );
          const job = requireJob(id);
          if (result.status === "failed" || result.status === "unknown") queueFailureNotice(id);
          if (result.status !== "retry")
            log(
              job,
              result.status === "sent"
                ? "Generated character image delivered to Telegram."
                : result.status === "unknown"
                  ? "Character image delivery outcome is unknown; it will not be resent automatically."
                  : "Character image delivery failed.",
              result.status !== "sent",
            );
          return job;
        })
        .immediate();
    },
    /** The model supplies notice text in the originating voice from the original turn snapshot. */
    claimFailureNotice(): ImageFailureNotice | null {
      return db
        .transaction(() => {
          if (
            db
              .query(
                "SELECT job_id FROM core_image_failure_notices WHERE status='generating' LIMIT 1",
              )
              .get()
          )
            return null;
          const row = db
            .query<{ id: string }, []>(`SELECT n.job_id AS id FROM core_image_failure_notices n
          JOIN core_image_jobs j ON j.id=n.job_id JOIN core_conversation_turns t ON t.id=j.turn_id
          WHERE n.status='pending' AND t.status IN ('delivered','failed','unknown') ORDER BY n.rowid LIMIT 1`)
            .get();
          if (!row) return null;
          db.query(
            "UPDATE core_image_failure_notices SET status='generating',updated_at=? WHERE job_id=?",
          ).run(now(), row.id);
          return getFailureNotice(row.id);
        })
        .immediate();
    },
    completeFailureNotice(id: string, text: string, result?: ConversationGenerationResult): void {
      if (typeof text !== "string" || !text.trim() || text.length > 4000)
        throw new TypeError("Image failure notices must have between 1 and 4000 characters.");
      db.transaction(() => {
        requireNotice(id, "generating");
        db.query(
          "UPDATE core_image_failure_notices SET status='ready',text=?,result_json=?,updated_at=? WHERE job_id=?",
        ).run(text, serializeResult(result), now(), id);
      }).immediate();
    },
    failFailureNotice(id: string, code: string, result?: ConversationGenerationResult): void {
      validateCode(code);
      db.transaction(() => {
        requireNotice(id, "generating");
        db.query(
          "UPDATE core_image_failure_notices SET status='failed',failure_code=?,result_json=?,updated_at=? WHERE job_id=?",
        ).run(code, serializeResult(result), now(), id);
        log(requireJob(id), "Could not compose an image failure notification.", true);
      }).immediate();
    },
    claimFailureNoticeDelivery(): ImageFailureNoticeDelivery | null {
      return db
        .transaction(() => {
          if (
            db
              .query("SELECT job_id FROM core_image_failure_notices WHERE status='sending' LIMIT 1")
              .get()
          )
            return null;
          const row = db
            .query<{ id: string }, []>(`SELECT n.job_id AS id FROM core_image_failure_notices n
          JOIN core_image_jobs j ON j.id=n.job_id JOIN core_conversation_turns t ON t.id=j.turn_id
          WHERE n.status='ready' AND t.status IN ('delivered','failed','unknown') ORDER BY n.rowid LIMIT 1`)
            .get();
          if (!row) return null;
          const notice = requireNotice(row.id, "ready");
          if (notice.text === null) throw new Error("Image failure notice has no generated text.");
          db.query(
            "UPDATE core_image_failure_notices SET status='sending',updated_at=? WHERE job_id=?",
          ).run(now(), row.id);
          return { ...notice, status: "sending" as const, text: notice.text };
        })
        .immediate();
    },
    recordFailureNoticeDelivery(
      id: string,
      result:
        | { status: "sent"; messageId: string }
        | { status: "failed" | "unknown"; code: string },
    ): void {
      if (result.status === "sent") {
        if (!/^[0-9]{1,30}$/.test(result.messageId))
          throw new TypeError("Invalid Telegram notice receipt.");
      } else validateCode(result.code);
      db.transaction(() => {
        requireNotice(id, "sending");
        const timestamp = now();
        db.query(`UPDATE core_image_failure_notices SET status=?,failure_code=?,telegram_message_id=?,
          delivered_at=?,updated_at=? WHERE job_id=?`).run(
          result.status,
          result.status === "sent" ? null : result.code,
          result.status === "sent" ? result.messageId : null,
          result.status === "sent" ? timestamp : null,
          timestamp,
          id,
        );
        log(
          requireJob(id),
          result.status === "sent"
            ? "Image failure notification delivered to Telegram."
            : "Image failure notification delivery did not receive confirmation.",
          result.status !== "sent",
        );
      }).immediate();
    },
    /** Called once by the lifecycle owner, after acquiring the existing Telegram worker lease. */
    recoverInterrupted(): { renders: number; deliveries: number } {
      return db
        .transaction(() => {
          const timestamp = now();
          const renders = db
            .query(`UPDATE core_image_jobs SET status='recovery',
          failure_code='interrupted_render',updated_at=? WHERE status IN ('submitting','running')`)
            .run(timestamp).changes;
          const deliveries = db
            .query(`UPDATE core_image_jobs SET status='unknown',
          failure_code='interrupted_delivery',updated_at=? WHERE status='sending'`)
            .run(timestamp).changes;
          db.query(`INSERT OR IGNORE INTO core_image_failure_notices(job_id,status,created_at,updated_at)
          SELECT id,'pending',?,? FROM core_image_jobs
          WHERE status='unknown' AND failure_code='interrupted_delivery'`).run(
            timestamp,
            timestamp,
          );
          db.query(
            "UPDATE core_image_failure_notices SET status='pending',updated_at=? WHERE status='generating'",
          ).run(timestamp);
          db.query(`UPDATE core_image_failure_notices SET status='unknown',failure_code='interrupted_delivery',
          updated_at=? WHERE status='sending'`).run(timestamp);
          if (renders || deliveries)
            activity.append({
              kind: "image_generation",
              summary: "Image worker recovered after restart; interrupted sends remain unknown.",
              status: deliveries ? "failed" : "succeeded",
              metadata: { renders, deliveries },
            });
          return { renders, deliveries };
        })
        .immediate();
    },
  };
}

export type ImageJobService = ReturnType<typeof createImageJobService>;
