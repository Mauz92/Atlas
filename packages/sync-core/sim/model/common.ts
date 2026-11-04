import { createHash } from "node:crypto";

/** A request as the model server sees it (the transport adapter fills `params` from `query`). */
export interface Req {
  method: string;
  path: string;
  params: Record<string, string | number | boolean>;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

export interface Resp {
  status: number;
  body: unknown;
}

export const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** JSON with sorted keys: the request fingerprint of the idempotency store. */
export function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(record[k])}`)
    .join(",")}}`;
}

export const error = (status: number, code: string, extra: Record<string, unknown> = {}): Resp => ({
  status,
  body: { error: code, ...extra },
});

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Label field per kind and the one simple field the simulation edits. */
export const LABEL = { task: "title", project: "name" } as const;
export const FLAG = { task: "priority", project: "status" } as const;
export const FLAG_DEFAULT = { task: "none", project: "active" } as const;
export const FLAG_VALUES = {
  task: ["low", "medium", "high"],
  project: ["active", "completed", "archived"],
} as const;

export type SimKind = "task" | "project";

export const textFields = (kind: SimKind): string[] => [LABEL[kind], "description"];
export const allFields = (kind: SimKind): string[] => [LABEL[kind], "description", FLAG[kind]];
