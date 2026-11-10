import { useCallback, useEffect, useState } from "react";

import type { Resolution } from "../api/client";
import { unseenNotices } from "../lib/syncUi/resolutionText";
import { markChangesSeen, seenSince } from "../lib/syncUi/seen";
import { defaultResolutionsSource, type ResolutionsSource } from "../lib/syncUi/source";

const POLL_MS = 60_000;

/**
 * New entries from other devices since the person last looked. Reads one small page when the shell
 * mounts, when the window regains focus and once a minute; a failure shows nothing (a banner must
 * never become a new error).
 */
export function useChangeNotices(source: ResolutionsSource = defaultResolutionsSource()) {
  const [notices, setNotices] = useState<Resolution[]>([]);

  const load = useCallback(async () => {
    try {
      const [page, own] = await Promise.all([source.page(null, 20), source.ownDeviceId()]);
      setNotices(unseenNotices(page.items, own, seenSince()));
    } catch {
      setNotices([]);
    }
  }, [source]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const dismiss = useCallback(() => {
    markChangesSeen();
    setNotices([]);
  }, []);

  return { notices, dismiss, reload: load };
}
