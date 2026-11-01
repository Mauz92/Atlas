import { act, renderHook, waitFor } from "@testing-library/react";

import type { ReminderPreferences } from "../api/client";
import { useReminderPreferences, type ReminderPreferencesApi } from "./useReminderPreferences";

function fakeApi(overrides: Partial<ReminderPreferencesApi> = {}): ReminderPreferencesApi & {
  get: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async (): Promise<ReminderPreferences> => ({ default: null })),
    update: vi.fn(async (): Promise<ReminderPreferences> => ({ default: null })),
    ...overrides,
  } as ReminderPreferencesApi & {
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

describe("useReminderPreferences", () => {
  it("loads the current default timing", async () => {
    const api = fakeApi({
      get: vi.fn(async () => ({ default: { days_before: 1, at_time: "09:00" } })),
    });
    const { result } = renderHook(() => useReminderPreferences(api));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.timing).toEqual({ days_before: 1, at_time: "09:00" });
    expect(result.current.error).toBeNull();
  });

  it("reports no timing as null (reminders off)", async () => {
    const { result } = renderHook(() => useReminderPreferences(fakeApi()));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.timing).toBeNull();
  });

  it("surfaces a load failure", async () => {
    const api = fakeApi({
      get: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const { result } = renderHook(() => useReminderPreferences(api));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("network down");
  });

  it("saves a timing and reports it as saved", async () => {
    const api = fakeApi({
      update: vi.fn(async () => ({ default: { days_before: 2, at_time: "08:30" } })),
    });
    const { result } = renderHook(() => useReminderPreferences(api));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.save({ days_before: 2, at_time: "08:30" });
    });

    expect(api.update).toHaveBeenCalledWith({ days_before: 2, at_time: "08:30" });
    expect(result.current.timing).toEqual({ days_before: 2, at_time: "08:30" });
    expect(result.current.saved).toBe(true);
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("clears the default when saving null", async () => {
    const api = fakeApi({
      get: vi.fn(async () => ({ default: { days_before: 1, at_time: "09:00" } })),
      update: vi.fn(async () => ({ default: null })),
    });
    const { result } = renderHook(() => useReminderPreferences(api));
    await waitFor(() => expect(result.current.timing).not.toBeNull());

    await act(async () => {
      await result.current.save(null);
    });

    expect(api.update).toHaveBeenCalledWith(null);
    expect(result.current.timing).toBeNull();
  });

  it("surfaces a save failure without claiming success", async () => {
    const api = fakeApi({
      update: vi.fn(async () => {
        throw new Error("rejected");
      }),
    });
    const { result } = renderHook(() => useReminderPreferences(api));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.save({ days_before: 1, at_time: "09:00" });
    });

    expect(result.current.error).toBe("rejected");
    expect(result.current.saved).toBe(false);
  });
});
