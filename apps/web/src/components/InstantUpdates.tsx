import { useState } from "react";

import type { StatusRow } from "../lib/syncUi/instantStatus";
import type { TestResult } from "../lib/syncUi/testNotification";
import { Icon, type IconName } from "./Icon";

const TONE_ICON: Record<StatusRow["tone"], IconName> = { ok: "check", warn: "triangle-alert", danger: "triangle-alert", quiet: "circle-dot" };

const TEST_TEXT: Record<TestResult, string> = {
  shown: "A test notification was sent to this device. If nothing appeared, check your system's Do Not Disturb or focus settings.",
  denied: "Notifications are not allowed for Atlas, so nothing was shown.",
  unsupported: "This browser cannot show notifications.",
  failed: "The test notification could not be shown.",
};

interface Props {
  rows: StatusRow[];
  /** Present when this device can show a test notification now. */
  onTest?: () => Promise<TestResult>;
  testEnabled?: boolean;
  loading?: boolean;
}

/**
 * Settings: instant updates and diagnostics (SYNC-11b, M8-04f web half). One row per fact with a
 * word, an icon (colour is never the only signal) and a sentence of help, plus an optional local test
 * notification. Presentational: every value comes from `lib/syncUi/instantStatus`.
 */
export function InstantUpdates({ rows, onTest, testEnabled = true, loading = false }: Props) {
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <section className="settings-group instant-updates" aria-labelledby="instant-title">
      <h3 id="instant-title">Instant updates</h3>
      {loading ? <p className="muted">Checking...</p> : null}
      <dl className="settings-facts instant-rows">
        {rows.map((row) => (
          <div key={row.id} className={`instant-row tone-${row.tone}`}>
            <dt>{row.label}</dt>
            <dd>
              <span className="instant-value">
                <Icon name={TONE_ICON[row.tone]} size={14} />
                {row.value}
              </span>
              <span className="muted instant-help">{row.help}</span>
            </dd>
          </div>
        ))}
      </dl>
      {onTest ? (
        <div className="settings-actions">
          <button
            type="button"
            disabled={busy || !testEnabled}
            onClick={() => {
              setBusy(true);
              void onTest()
                .then(setResult)
                .finally(() => setBusy(false));
            }}
          >
            Show a test notification
          </button>
          {!testEnabled ? <span className="muted">Allow notifications first.</span> : null}
          <span role="status" aria-live="polite">
            {result ? TEST_TEXT[result] : ""}
          </span>
        </div>
      ) : null}
    </section>
  );
}
