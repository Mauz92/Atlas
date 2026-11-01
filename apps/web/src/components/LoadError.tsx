interface LoadErrorProps {
  message: string | null;
  onRetry: () => void;
}

/** Shared inline error with a retry action (PRODUCT_SPEC §5.7: clear errors, no clutter). */
export function LoadError({ message, onRetry }: LoadErrorProps) {
  return (
    <div className="error-state">
      <p className="error" role="alert">
        {message ?? "Something went wrong"}
      </p>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
