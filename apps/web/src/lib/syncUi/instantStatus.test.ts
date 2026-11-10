import { canTestNotification, gatewayRow, lastHintRow, liveRow, notificationRow } from "./instantStatus";

const NOW = Date.parse("2026-11-10T12:00:00Z");

describe("instant updates wording", () => {
  it.each([
    ["unsupported", "default", "Not supported", "danger"],
    ["disabled", "default", "Not available on this server", "warn"],
    ["denied", "denied", "Blocked", "danger"],
    ["prompt", "default", "Not asked yet", "quiet"],
    ["granted", "granted", "Allowed, not registered", "warn"],
    ["subscribed", "granted", "On", "ok"],
  ] as const)("notifications: %s", (state, permission, value, tone) => {
    expect(notificationRow(state, permission)).toMatchObject({ value, tone });
    expect(notificationRow(state, permission).help.length).toBeGreaterThan(10);
  });

  it("a test needs granted permission and a supporting browser", () => {
    expect(canTestNotification("subscribed", "granted")).toBe(true);
    expect(canTestNotification("prompt", "default")).toBe(false);
    expect(canTestNotification("unsupported", "granted")).toBe(false);
  });

  it("live connection: browser says it is not used, desktop says connected or not", () => {
    expect(liveRow("browser", false).value).toBe("Not used in a browser");
    expect(liveRow("desktop", true)).toMatchObject({ value: "Connected", tone: "ok" });
    expect(liveRow("desktop", false)).toMatchObject({ value: "Not connected", tone: "warn" });
  });

  it("last hint", () => {
    expect(lastHintRow(null, NOW).value).toBe("None yet");
    expect(lastHintRow(NOW - 120_000, NOW).value).toMatch(/2 minutes ago/);
  });

  it("gateway: every state has copy, the topic is never shown beyond its last characters", () => {
    expect(gatewayRow(null, true, NOW).value).toBe("Could not be read");
    expect(gatewayRow({ enabled: false, registered: false }, false, NOW)).toMatchObject({ value: "Not configured", tone: "quiet" });
    expect(gatewayRow({ enabled: true, registered: false }, false, NOW).value).toBe("On, this device not registered");
    expect(gatewayRow({ enabled: true, registered: true, invalid: true, endpoint_tail: "ab12" }, false, NOW).value).toBe("Needs a new address (ending ab12)");
    expect(gatewayRow({ enabled: true, registered: true, failures: 3, last_error_class: "timeout" }, false, NOW).help).toMatch(/3 sends failed \(timeout\)/);
    const ok = gatewayRow({ enabled: true, registered: true, endpoint_tail: "wxyz", last_ok_at: "2026-11-10T11:58:00Z" }, false, NOW);
    expect(ok).toMatchObject({ value: "Working (ending wxyz)", tone: "ok" });
    expect(ok.help).toMatch(/2 minutes ago/);
  });
});
