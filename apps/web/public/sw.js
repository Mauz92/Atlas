/*
 * Atlas service worker (M8-02).
 *
 * Handles a Web Push message from the server and shows it as a desktop notification, even when the
 * Atlas tab is closed. The payload is the JSON `{ title, body, data }` the backend sends (see
 * `services/api/atlas/reminders/push.py`). This file is intentionally dependency-free vanilla JS: it
 * is copied verbatim into the build by Vite and must run in the service-worker global scope.
 *
 * No custom cryptography lives here — the payload is already decrypted by the browser's push service
 * using the subscription keys; this worker only renders what it receives. Nothing is cached.
 */

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A payload that is not JSON is still worth showing rather than dropping silently.
    payload = { body: event.data ? event.data.text() : "" };
  }

  const title = typeof payload.title === "string" ? payload.title : "Atlas";
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const options = {
    body: typeof payload.body === "string" ? payload.body : "You have a reminder.",
    data,
    // The stable dedupe key collapses a duplicate push into one notification.
    tag: typeof data.dedupe_key === "string" ? data.dedupe_key : undefined,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an existing Atlas window when the notification is clicked, or open one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if ("focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow("/");
    })(),
  );
});
