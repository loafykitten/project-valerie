import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Store } from "@valerie/core";
import {
  InferenceError,
  type NeuralwattCatalog,
  type NeuralwattModel,
  type Transport,
} from "../packages/inference/src";

// Shared plumbing for the explicit provider probes. Nothing here reads keys or
// contacts a provider by itself; each probe still owns its budget and report shape.

export const NEURALWATT_MODELS_URL = "https://api.neuralwatt.com/v1/models";
export const NEURALWATT_COMPLETIONS_URL = "https://api.neuralwatt.com/v1/chat/completions";

/** The provider request ID when it is a plain identifier; anything else is recorded as null. */
export function receiptRequestId(response: Response): string | null {
  const id = response.headers.get("x-request-id");
  return id && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(id) ? id : null;
}

export interface ProbeReceipt {
  requestId: string | null;
  status: number;
}

/**
 * A completion-only transport with a total and optional per-turn request ceiling.
 * Each request is counted before contacting the provider, so a timeout still consumes
 * budget. Callers reset `turn` at the start of every owner turn.
 */
export function budgetedCompletions(limits: { total: number; perTurn?: number }) {
  const budget = {
    receipts: [] as ProbeReceipt[],
    paid: 0,
    turn: 0,
    transport: (async (url, init) => {
      if (
        url !== NEURALWATT_COMPLETIONS_URL ||
        budget.paid >= limits.total ||
        budget.turn >= (limits.perTurn ?? Number.POSITIVE_INFINITY)
      )
        throw new InferenceError("configuration");
      budget.paid++;
      budget.turn++;
      const response = await fetch(url, init);
      budget.receipts.push({ requestId: receiptRequestId(response), status: response.status });
      return response;
    }) as Transport,
  };
  return budget;
}

/** Write a private report under data/reviews without replacing an earlier run. */
export async function writeReviewReport(
  name: string,
  runId: string,
  report: Record<string, unknown>,
): Promise<string> {
  const directory = resolve(import.meta.dir, "../data/reviews");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}-${runId}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return path;
}

/** Provider-reported token counts recorded by fictional stores for completed requests. */
export function reportedTokenRows(stores: readonly Store[]) {
  return stores.flatMap((store) =>
    store.db
      .query<{ input: number | null; output: number | null; reasoning: number | null }, []>(
        "SELECT input_tokens AS input,output_tokens AS output,reasoning_tokens AS reasoning FROM core_context_requests WHERE finish_reason IS NOT NULL",
      )
      .all(),
  );
}

/** `check` output for the single-model inference probes. */
export function printCatalogCheck(catalog: NeuralwattCatalog, model: NeuralwattModel): void {
  console.log(
    JSON.stringify(
      { checkedAt: catalog.checkedAt, scope: catalog.scope, requestId: catalog.requestId, model },
      null,
      2,
    ),
  );
}

/** Failure output for the single-model inference probes; never includes provider bodies. */
export function printInferenceProbeFailure(error: unknown): void {
  console.error(
    JSON.stringify({
      status: "failed",
      code: error instanceof InferenceError ? error.code : "local_failure",
      httpStatus: error instanceof InferenceError ? (error.status ?? null) : null,
      retried: false,
    }),
  );
  process.exitCode = 1;
}
