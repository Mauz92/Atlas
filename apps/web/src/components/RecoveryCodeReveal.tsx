import { useId, useState } from "react";

interface Props {
  /** The one-time code, exactly as the server returned it (grouped, upper case). */
  code: string;
  /** Label of the button that leaves the screen (enabled only after the acknowledgement). */
  continueLabel: string;
  onContinue: () => void;
}

type CopyState = "idle" | "copied" | "failed";

/**
 * Shows a recovery code **once** (AUTH-01, ADR-0067): copy, download, and an explicit "I have
 * saved it" step before the owner may continue. The code lives in this component's props only;
 * nothing here writes it to storage, the URL or the console. After "Continue" the parent drops it
 * and there is no way to see it again (the server keeps only a hash).
 */
export function RecoveryCodeReveal({ code, continueLabel, onContinue }: Props) {
  const [saved, setSaved] = useState(false);
  const [copy, setCopy] = useState<CopyState>("idle");
  const codeId = useId();

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  function downloadCode() {
    const text =
      "Atlas recovery code\n\n" +
      `${code}\n\n` +
      "Keep this file private. With your account email, this code lets whoever holds it set a new\n" +
      "password for your Atlas account. It works once: using it issues a new code.\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "atlas-recovery-code.txt";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="recovery-reveal">
      <p>
        If you forget your password, this code and your email let you set a new one. It is shown
        only now: Atlas keeps no copy you can read.
      </p>
      <p
        id={codeId}
        className="recovery-code"
        aria-label="Your recovery code"
        data-testid="recovery-code"
      >
        {code}
      </p>
      <div className="recovery-actions">
        <button type="button" onClick={() => void copyCode()}>
          Copy code
        </button>
        <button type="button" onClick={downloadCode}>
          Download as file
        </button>
      </div>
      <p className="hint" role="status">
        {copy === "copied" ? "Copied to the clipboard." : null}
        {copy === "failed" ? "Could not copy. Select the code and copy it by hand." : null}
      </p>
      <label>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have
        saved my recovery code
      </label>
      <button type="button" className="primary" disabled={!saved} onClick={onContinue}>
        {continueLabel}
      </button>
    </div>
  );
}
