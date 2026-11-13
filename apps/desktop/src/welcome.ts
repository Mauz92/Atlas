/**
 * The sign-in page of the desktop shell (SYNC-09c). It talks only to `window.atlasDesktop`. Layout: one form,
 * messages in plain words for every state the runtime can end up in (signed out by the server, update required,
 * keystore unavailable). After a successful sign-in the app page is opened.
 */
import type { Bridge } from "./bridge.ts";

const win = window as unknown as { atlasDesktop?: Bridge; atlasDesktopReady?: Promise<{ phase: string; reason: string | null }> };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const MESSAGES: Record<string, string> = {
  signed_out: "This device was signed out (it may have been removed in Settings on another device, or its key expired). Sign in again to continue; nothing on this computer was deleted.",
  token_revoked: "This device was signed out from another device. Sign in again to continue; nothing on this computer was deleted.",
  token_expired: "This device's key expired. Sign in again to continue; nothing on this computer was deleted.",
  update_required: "This version of Atlas is too old for your server. Install the newer Atlas desktop app; your data on this computer is kept.",
  keystore_unavailable: "Atlas could not reach your system keystore (Secret Service / KWallet / Credential Manager). Start or unlock it and reopen Atlas: Atlas never stores the device key in a file.",
};

const FAILURES: Record<string, string> = {
  invalid_credentials: "The e-mail or password was not accepted.",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  unreachable: "The server could not be reached. Check the address and your connection.",
  insecure_url: "",
  update_required: MESSAGES["update_required"]!,
  keystore_unavailable: MESSAGES["keystore_unavailable"]!,
  server_error: "The server answered with an error. Try again later.",
};

function show(el: HTMLElement, text: string | null) {
  el.hidden = !text;
  el.textContent = text ?? "";
}

let folderOnPhone = false;

async function main() {
  const desktop = win.atlasDesktop;
  if (!desktop) {
    show($("notice"), "This page only works inside the Atlas desktop app.");
    return;
  }
  const snapshot = await win.atlasDesktopReady!;
  const reason = new URLSearchParams(location.search).get("reason") ?? snapshot.reason;
  if (snapshot.phase === "running") {
    location.replace("/");
    return;
  }
  if (reason) show($("notice"), MESSAGES[reason] ?? null);
  if (snapshot.phase === "update_required" || reason === "update_required") return; // nothing to sign in to
  const android = /Android/i.test(navigator.userAgent);
  if (android) {
    // a phone: no tray, no start-at-login (reminders are OS alarms), no folder dialog (the notes live in the app; ADR-0075)
    document.body.classList.add("android");
    $("lead").textContent = "Sign this phone in to your own Atlas server. Your password is sent once to get a device key; the key is kept in the Android Keystore and the password is never stored.";
    $("autostart-row").hidden = true;
    $("tray-hint").hidden = true;
    $("folder-box").hidden = true;
    folderOnPhone = true;
  }
  $<HTMLInputElement>("device").value = android ? "Android phone" : `${navigator.platform.includes("Win") ? "Windows" : "Linux"} desktop`;
  let folder = (await desktop.snapshot()).notes?.root ?? null;
  // on a phone the folder is the app's own: granted automatically at sign-in
  const folderLabel = $("folder");
  const refreshFolder = () => (folderLabel.textContent = folder ?? "not chosen (you can choose it later in Settings)");
  refreshFolder();
  $("choose").addEventListener("click", async () => {
    folder = (await desktop.chooseNotesFolder()) ?? folder;
    refreshFolder();
  });
  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $<HTMLButtonElement>("submit");
    submit.disabled = true;
    show($("error"), null);
    try {
      const result = await desktop.signIn({
        baseUrl: $<HTMLInputElement>("server").value,
        email: $<HTMLInputElement>("email").value,
        password: $<HTMLInputElement>("password").value,
        deviceName: $<HTMLInputElement>("device").value.trim(),
      });
      if (!result.ok) {
        show($("error"), FAILURES[result.failure] || result.detail);
        return;
      }
      $<HTMLInputElement>("password").value = "";
      if (folderOnPhone && !folder) await desktop.chooseNotesFolder();
      await desktop.answerAutostart($<HTMLInputElement>("autostart").checked);
      location.replace("/");
    } catch (error) {
      show($("error"), error instanceof Error ? error.message : "Sign-in failed.");
    } finally {
      submit.disabled = false;
    }
  });
  // shown only now: a submit before the handler above exists would be the browser's own form submission (a reload with the password in the URL)
  $("form").hidden = false;
}

void main();
