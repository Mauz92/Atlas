import { useAuth } from "../auth/AuthProvider";
import { RecoveryCodeReveal } from "../components/RecoveryCodeReveal";

/** First-run: the new owner must see and acknowledge the recovery code before using Atlas. */
export function RecoveryCodeSetup({ code }: { code: string }) {
  const { acknowledgeRecoveryCode } = useAuth();
  return (
    <main className="auth-page">
      <section className="card" aria-labelledby="recovery-setup-title">
        <h1 id="recovery-setup-title">Save your recovery code</h1>
        <RecoveryCodeReveal
          code={code}
          continueLabel="Continue to Atlas"
          onContinue={acknowledgeRecoveryCode}
        />
      </section>
    </main>
  );
}
