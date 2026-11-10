/**
 * Wording for the three states in which syncing stops and waits for a person (SYNC-11a-4,
 * SYNC_PROTOCOL 7.4 and 8.1): the server was restored (`cursor_ahead` / `epoch_mismatch`), the app
 * is too old (426), the device was signed out (401). Pure: the screen renders it.
 */
export type HaltView =
  | { kind: "update_required"; min: number | null; max: number | null }
  | { kind: "signed_out"; code: string }
  | { kind: "restore_confirmation"; reason: "epoch_mismatch" | "cursor_ahead"; epoch: string | null; head: number | null };

export interface HaltInfo {
  /** Unsent changes on this device. */
  pending: number;
  /** This device's feed position. */
  cursor: number;
}

export interface HaltText {
  title: string;
  /** Paragraphs, in order. */
  body: string[];
  /** The facts the person can read off (what the server lost; what this device holds). */
  facts: { label: string; value: string }[];
}

function changes(n: number): string {
  return n === 1 ? "1 unsent change" : `${n} unsent changes`;
}

export function describeHalt(halt: HaltView, info: HaltInfo): HaltText {
  if (halt.kind === "restore_confirmation") {
    const facts: { label: string; value: string }[] = [{ label: "Unsent changes on this device", value: String(info.pending) }];
    if (halt.reason === "cursor_ahead") {
      facts.unshift({ label: "This device has seen up to", value: `change ${info.cursor}` });
      if (halt.head !== null) facts.unshift({ label: "The server is now at", value: `change ${halt.head}` });
    }
    return {
      title: "The server was restored from a backup",
      body: [
        halt.reason === "epoch_mismatch"
          ? "The administrator restored this server from a backup, so it may have lost the newest changes. Atlas stopped syncing on this device so it cannot add or remove anything by itself."
          : "This device has seen newer changes than the server has now, which means the server was restored from an older backup. Atlas stopped syncing so it cannot add or remove anything by itself.",
        "Choose what this device should do. Nothing happens until you choose.",
      ],
      facts,
    };
  }
  if (halt.kind === "update_required") {
    const range = halt.min !== null && halt.max !== null ? ` The server speaks sync protocol ${halt.min} to ${halt.max}.` : "";
    return {
      title: "Atlas needs to be updated",
      body: [
        `This version of Atlas is too old (or too new) for your server.${range} Install the matching Atlas app, then check again.`,
        `Your data on this device is kept${info.pending > 0 ? `, including ${changes(info.pending)}` : ""}. Nothing is sent until the app is updated.`,
      ],
      facts: [],
    };
  }
  const why =
    halt.code === "token_revoked"
      ? "This device was signed out from another device or from Settings."
      : halt.code === "token_expired"
        ? "This device's key expired."
        : "The server no longer accepts this device's key.";
  return {
    title: "This device was signed out",
    body: [
      `${why} Sign in again to continue.`,
      info.pending > 0
        ? `Nothing on this device was deleted. ${changes(info.pending)} will be sent after you sign in.`
        : "Nothing on this device was deleted.",
    ],
    facts: [],
  };
}
