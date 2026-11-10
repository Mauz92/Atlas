import { useInstanceInfo } from "../../hooks/useInstanceInfo";
import { isDesktopShell } from "../../lib/desktop";
import { LoadError } from "../LoadError";
import { Skeleton } from "../Skeleton";
import { UpdateSection } from "./UpdateSection";

/** Version and health of this instance (`GET /api/instance`). */
export function AboutSection() {
  const { info, error, reload } = useInstanceInfo();
  if (error) {
    return <LoadError message={error} onRetry={() => void reload()} />;
  }
  if (!info) {
    return (
      <Skeleton label="Loading instance information" rows={4} kind="line" />
    );
  }
  return (
    <>
      <section className="settings-group" aria-labelledby="settings-instance">
        <h3 id="settings-instance">Instance</h3>
        <dl className="settings-facts">
          <div>
            <dt>Atlas version</dt>
            <dd>{info.version}</dd>
          </div>
          <div>
            <dt>Environment</dt>
            <dd>{info.environment}</dd>
          </div>
          <div>
            <dt>Database</dt>
            <dd>{info.database}</dd>
          </div>
          <div>
            <dt>Schema revision</dt>
            <dd>{info.migration_revision ?? "unknown"}</dd>
          </div>
          <div>
            <dt>Web Push</dt>
            <dd>
              {info.web_push_configured ? "configured" : "not configured"}
            </dd>
          </div>
        </dl>
      </section>
      {isDesktopShell() ? null : <UpdateSection />}
    </>
  );
}
