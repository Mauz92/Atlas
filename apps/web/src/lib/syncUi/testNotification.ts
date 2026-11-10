/** A local test notification (SYNC-11b): proves this device can show one. It does not use the server. */
export type TestResult = "shown" | "denied" | "unsupported" | "failed";

export async function showTestNotification(): Promise<TestResult> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "granted") return "denied";
  const options = { body: "If you can read this, Atlas can show notifications on this device.", tag: "atlas-test" };
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration) await registration.showNotification("Atlas test notification", options);
    else new Notification("Atlas test notification", options);
    return "shown";
  } catch {
    return "failed";
  }
}
