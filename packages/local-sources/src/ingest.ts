import type { IngestBatch, IngestFinish, IngestRunOpen } from "@bertbooker/core";

/** Where findings go, and how to prove we're allowed to send them. */
export interface IngestConfig {
  /** e.g. http://127.0.0.1:8787 in dev, https://bertbooker.com in prod. */
  baseUrl: string;
  /** Shared secret matching the Worker's `INGEST_TOKEN`. The only credential
   *  prod ingest needs — nothing fronts the Worker but its own gate. */
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface IngestClient {
  open(run: IngestRunOpen): Promise<void>;
  push(runId: string, batch: IngestBatch): Promise<void>;
  finish(runId: string, f: IngestFinish): Promise<void>;
}

/**
 * HTTP client for `/api/ingest/*`.
 *
 * Failures here are NOT swallowed. A run that gathered perfectly but couldn't
 * store anything is a failed run, and the CLI needs to say so loudly — the one
 * thing worse than no data is believing you have data you don't.
 */
export function makeIngestClient(cfg: IngestConfig): IngestClient {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = cfg.baseUrl.replace(/\/$/, "");

  const post = async (path: string, body: unknown): Promise<unknown> => {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.token ? { "X-Ingest-Token": cfg.token } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ingest ${path} -> ${res.status} ${text.slice(0, 300)}`);
    }
    return res.json().catch(() => ({}));
  };

  const run = (id: string) => `/api/ingest/runs/${encodeURIComponent(id)}`;

  return {
    open: async (r) => void (await post("/api/ingest/runs", r)),
    push: async (runId, batch) => {
      if (!batch.tasks.length && !batch.logs?.length && !batch.quota?.length) return;
      await post(`${run(runId)}/tasks`, batch);
    },
    finish: async (runId, f) => void (await post(`${run(runId)}/finish`, f)),
  };
}
