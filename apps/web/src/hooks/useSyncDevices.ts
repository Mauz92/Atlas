import { useCallback, useEffect, useState } from "react";

import { devicesApi, type SyncDevice } from "../api/client";
import { errorMessage } from "../lib/settingsFormat";

/** The signed-in sync devices (`GET /api/devices`) and the three things the owner can do to them. */
export function useSyncDevices() {
  const [devices, setDevices] = useState<SyncDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDevices((await devicesApi.list()).items);
    } catch (err) {
      setError(errorMessage(err, "Could not load the devices"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run one action, then re-read the list so the page shows what the server holds. */
  const act = useCallback(
    async (key: string, fn: () => Promise<string>, failure: string): Promise<boolean> => {
      setBusy(key);
      setActionError(null);
      setNotice(null);
      try {
        setNotice(await fn());
        await load();
        return true;
      } catch (err) {
        setActionError(errorMessage(err, failure));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const rename = useCallback(
    (device: SyncDevice, name: string) =>
      act(device.id, async () => {
        await devicesApi.rename(device.id, name);
        return `Renamed to ${name.trim()}`;
      }, "Could not rename the device"),
    [act],
  );

  const revoke = useCallback(
    (device: SyncDevice) =>
      act(device.id, async () => {
        await devicesApi.revoke(device.id);
        return `${device.name} was signed out`;
      }, "Could not sign the device out"),
    [act],
  );

  const revokeAll = useCallback(
    () =>
      act("all", async () => {
        const { revoked } = await devicesApi.revokeAll();
        return revoked === 1 ? "1 device was signed out" : `${revoked} devices were signed out`;
      }, "Could not sign the devices out"),
    [act],
  );

  return { devices, error, actionError, notice, busy, reload: load, rename, revoke, revokeAll };
}
