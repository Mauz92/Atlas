import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useCalendarAccounts } from "../hooks/useCalendarAccounts";
import { connectResultMessage } from "../lib/calendar";
import { ProviderCard } from "./calendar/ProviderCard";
import { LoadError } from "./LoadError";
import { Skeleton } from "./Skeleton";

/**
 * The Calendar section of Settings (M5-05, M5-11): one card each for Google, Microsoft and ICS
 * feeds. Each card shows the state the server reports (not configured → setup help, not connected,
 * connected, needs re-authorisation, error), the connect/disconnect/sync actions and the account's
 * calendars. The OAuth callback lands here with `?calendar_result=…`, shown once as a banner and
 * then removed from the address bar. Everything is read-only towards the providers.
 */
export function CalendarSettings() {
  const actions = useCalendarAccounts();
  const [params, setParams] = useSearchParams();
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const result = params.get("calendar_result");
  const resultProvider = params.get("calendar_provider") ?? "";

  useEffect(() => {
    if (!result) return;
    setBanner(connectResultMessage(result, resultProvider));
    const next = new URLSearchParams(params);
    next.delete("calendar_result");
    next.delete("calendar_provider");
    setParams(next, { replace: true });
  }, [result, resultProvider, params, setParams]);

  return (
    <div className="cal-settings">
      {banner ? (
        <p className={banner.ok ? "cal-banner" : "cal-banner cal-banner-warn"} role="status">
          {banner.text}
        </p>
      ) : null}
      {actions.actionError ? <p className="error" role="alert">{actions.actionError}</p> : null}
      {actions.state === "loading" && actions.providers.length === 0 ? <Skeleton label="Loading calendars" rows={3} kind="card" /> : null}
      {actions.state === "error" ? <LoadError message={actions.error} onRetry={() => void actions.reload()} /> : null}
      {actions.providers.length > 0 ? (
        <ul className="cal-cards">
          {actions.providers.map((provider) => (
            <ProviderCard
              key={provider.provider}
              provider={provider}
              actions={{
                ...actions,
                disconnect: async (name) => {
                  const note = await actions.disconnect(name);
                  if (note) setNotes((current) => ({ ...current, [name]: note }));
                  return note;
                },
              }}
              note={notes[provider.provider] ?? null}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
