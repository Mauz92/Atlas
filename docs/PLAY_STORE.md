# Google Play distribution plan (PROPOSED)

**Status:** DEFERRED, 2026-11-17 (the owner chose the free GitHub Release APK; ADR-0079). Kept as reference in case Play is reconsidered. The decision record is ADR-0079 (PROPOSED); tasks are PLAY-01 to PLAY-12 in `ROADMAP.md`; risks R-86 to R-88 in `RISKS.md`. Until ADR-0079 is ACCEPTED, ADR-0075 D8 stands: **Atlas for Android is a sideloaded APK**.

This file is the single place for the Play-specific steps, copy and form answers. It does not repeat the build instructions (`apps/desktop/README.md`) or the release gates (`RELEASE.md`).

Facts below marked **[Google, checked 2026-11-16]** came from Google's help pages or search results summarising them. Play policy changes often: re-check each one in the Play Console on the day you act. Anything marked **[UNVERIFIED]** is the agent's reading, not evidence.

## 1. Decisions the owner must make first (blocking)

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | Publish on Play at all? | Decide after reading section 6 (effort and what changes). F-Droid or a GitHub-hosted APK avoid 5 of the 8 items below | Play adds an account, a 14-day test, reviewer access, policy forms and ongoing maintenance |
| D2 | Account type | **Personal** if no company exists; **organisation** (needs a D-U-N-S number) skips the closed-test rule | See step 2 |
| D3 | Reviewer access | A **separate, public, throwaway demo server with fake data** (ADR-0079 D4); never the owner's real server | Play reviewers must be able to sign in; real Atlas is tailnet-only (SEC-01) and a public demo is the first exposure of any Atlas code, so it needs explicit approval (AGENTS.md 18) |
| D4 | Where does the privacy policy live? | A static page on a domain you control, or GitHub Pages from a **public** repository | The repository is private; Play requires a public URL |
| D5 | Store name | Something unlikely to be rejected as a clash, e.g. "Atlas Notes and Tasks (self-hosted)" | Many Play apps are called "Atlas" **[UNVERIFIED]** |
| D6 | Signing | Enrol in **Play App Signing** and use a **new, separate upload key**; keep the existing sideload key (`apps/desktop/keys/`) for sideloaded APKs | Play re-signs with Google's key, so a Play install and a sideloaded APK have different signatures and cannot update each other. Both keys must be backed up offline (R-85) |

## 2. Step by step

Legend: **O** = only the owner can do it (accounts, payment, identity, legal), **A** = the agent can prepare or do it, **O+A** = both.

### Phase 0 - Decide (O)
1. Answer D1 to D6 above. Accept or reject ADR-0079.

### Phase 1 - Account (O)
2. Create a Google Play Console developer account. One-time fee of 25 USD **[Google, checked 2026-11-16]**.
3. Complete identity verification (legal name, address, phone, email, and the identity document Google asks for).
4. **Personal accounts created after 13 November 2023** must run a **closed test with at least 12 testers opted in for 14 continuous days** before applying for production access; an organisation account is exempt **[Google, checked 2026-11-16]**. Pausing the closed-test track can reset the clock (secondary sources). Plan about three weeks from first upload to a live app: 14 days of testing, a production-access decision (about 2 days) and review (up to 7 days) **[secondary sources]**.
5. Android **developer verification**: Google is registering apps by package name and signing certificate; Play Console registers apps published on Play automatically or from the Home page. Enforcement began in September 2026 in four countries and is planned globally for 2027; apps only sideloaded will also need an Android Developer Console registration, with a free limited-distribution tier for hobbyists (up to 20 devices) **[Google blog June 2026 via search results; re-check]**. This affects the **sideloaded APK too**, independently of Play.

### Phase 2 - Make the build Play-compatible (A)
6. **PLAY-01 (built, IN_REVIEW):** `apps/desktop/scripts/build-android.sh play` builds a **release App Bundle** (`.aab`, all four ABIs) and `ATLAS_PLAY=1` removes `MANAGE_EXTERNAL_STORAGE` from the merged manifest. The normal APK build is unchanged. Not yet run end to end (needs the toolchain and the owner's key); the manifest edit was tested on a copy of the generated manifest (add, remove, add again).
7. **PLAY-02:** hide the "shared notes folder" row in Settings when the permission is not declared (otherwise the Play build offers a feature that cannot work). Keep "Export notes" (it is the portability answer, R-82). A SAF-based shared folder (SYNC-07 S3) is the only compliant way to bring that feature to Play and is out of scope here.
8. **PLAY-03: 16 KB page size.** Atlas ships Rust native libraries built with **NDK 27**, whose default alignment is 4 KB. Google requires native code in apps targeting Android 15+ to support 16 KB pages; the start date differs between sources (1 Nov 2025 or 1 May 2026), so assume it is in force **[Google, checked 2026-11-16]**. Fix: link with `-Wl,-z,max-page-size=16384` (or move to NDK 28+, where it is the default), then verify the shipped `.so` files (`llvm-readelf -lW` shows `LOAD` alignment `0x4000` or more; `zipalign -c -P 16 4 app.apk` for the APK). Add the check to `scripts/build-android.sh`.
9. **PLAY-04: target SDK.** Atlas targets API 37, above the current Play minimum of **API 36 for new apps and updates from 31 August 2026** **[Google, checked 2026-11-16]**. Nothing to do now; re-check each year.
10. **PLAY-05: bundle sanity.** Install the `.aab` on the phone with `bundletool build-apks` and re-run the existing real-phone e2e (`apps/desktop/e2e/android.mjs`, which must stay `14/14`), because an AAB-split install is a different delivery path from the APK.
11. Version: the app version comes from `tauri.conf.json` (`0.1.0`); Tauri derives `versionCode`. Every Play upload needs a **strictly higher** `versionCode` than any earlier upload, including test tracks; confirm the derivation yields a monotonic value or set `bundle.android.versionCode` explicitly **[UNVERIFIED]**.

### Phase 3 - Reviewer access and policy material (A drafts, O approves)
12. **PLAY-06: demo server.** Play asks for working login credentials when the app needs a sign-in ("App access"). Atlas needs a server, so a reviewer cannot use it otherwise. Plan: a **separate Atlas deployment** (same release images, `deploy/docker-compose.release.yml`), seeded with fake data, a demo account whose password is given only in the Play Console, rate-limited, wiped nightly, on a public HTTPS certificate (the Android app trusts only public CAs, ADR-0075 D6). This is the **first public exposure** of Atlas and conflicts with "tailnet only until SEC-01"; ADR-0079 D4 makes it an explicit owner decision with its own risk (R-87). Alternatives considered in section 6.
13. **PLAY-07: privacy policy** (appendix A is the draft). Publish it at a public URL (D4).
14. **PLAY-08: Data safety and other declarations** (appendix B is the draft answers). The owner submits them; the agent only supplies text.
15. **PLAY-09: permission declarations** (appendix C): exact alarms and the foreground service need written justification, the foreground service possibly a short demo video (recorded from the phone with the keep-connected mode on).
16. **PLAY-10: store listing assets** (appendix D): title, short and long description, 512x512 icon, 1024x500 feature graphic, at least 2 phone screenshots (capture from the phone or emulator with demo data), a category (Productivity), contact email, content rating questionnaire, ads declaration (no ads), target audience (adults), "news app" and "government app" (no).

### Phase 4 - Test track (O does the Console, A supports)
17. Create the app in the Console: default language, "App" (not game), free, declarations of the policies it requires.
18. Opt in to Play App Signing; create the **upload key** (D6) and upload the first `.aab` to an **Internal testing** track (testers by email, available within minutes) to find install problems early.
19. Promote to a **Closed testing** track and recruit **12+ real testers** who opt in and stay opted in for **14 continuous days** (people who will install it, from the owner's contacts; paid tester services violate the spirit of the rule and are not recommended). Testers need a Google account and, because Atlas needs a server, **access to the demo server**. Use the 14 days to collect crash reports and feedback and fix them with new `versionCode`s.
20. Apply for **production access** in the Console (it asks how testing went).

### Phase 5 - Production (O)
21. Create the production release with the final `.aab`, release notes (from `CHANGELOG.md`), the countries (start with a few), and send for review. First review commonly takes up to about 7 days **[secondary sources]**.
22. If rejected, read the policy citation, fix it (likely areas: section 3), and resubmit; record the outcome in `ACCEPTANCE.md` and `RISKS.md`.
23. After release: staged rollout percentage, watch Android vitals and crashes, keep the upload key backed up, and re-check the target-SDK rule each year. Updates go through the Console, not through a sideloaded APK.

## 3. Policy surfaces most likely to be questioned

| Item | In Atlas | Plan |
|---|---|---|
| `MANAGE_EXTERNAL_STORAGE` | Used only by the optional shared notes folder | **Removed in the Play build** (PLAY-01) and the UI hidden (PLAY-02). Not justifiable for a notes app on Play **[UNVERIFIED]** |
| `USE_EXACT_ALARM` | Task reminders armed with `AlarmManager.setAlarmClock` (ADR-0075 D5) | Permission is for alarm-clock and calendar apps. Atlas is a planner whose core feature is timed reminders and a calendar view, so declare it as "calendar/reminder functionality" and expect a possible rejection. **Fallback:** `SCHEDULE_EXACT_ALARM` (the user grants it in system settings, can revoke it, and revocation stops the app and cancels exact alarms, R-84). Decide the fallback only if Play rejects, because it weakens the reminder guarantee |
| `FOREGROUND_SERVICE_SPECIAL_USE` | Optional "Keep Atlas connected" service, off by default, visible notification | The manifest already carries the subtype text; the Console asks for a description and possibly a video |
| `RECEIVE_BOOT_COMPLETED`, `POST_NOTIFICATIONS`, `INTERNET` | Reminders re-armed after boot; notifications; server access | Normal |
| User content sent off-device | Notes and tasks sync to the user's own server | Data safety answer, appendix B |
| App needs an external server | Yes (the user's own) | Say so first in the description; demo server for reviewers |
| Third-party code | Tauri, WebView, Rust crates; no ads, analytics or telemetry (AGENTS.md 11) | Nothing to declare beyond the form |

## 4. What stays unverified until it is done

- That Google accepts `USE_EXACT_ALARM` for Atlas.
- That the app passes review with a demo login and a self-hosted-server premise.
- 16 KB alignment of the shipped libraries (PLAY-03) and an AAB install on a real phone (PLAY-05).
- The current wording of every Google requirement quoted above.

## 5. Costs and obligations (AGENTS.md 14)

25 USD once; the demo server (an extra small host or container and a domain, owner's cost); the owner's time for 14 days of tester coordination; ongoing: yearly target-SDK bump, policy re-checks, answering reviews and crash reports; the Play listing makes Atlas **publicly discoverable**, which changes the support expectation of a "personal self-hosted" product. No paid service is introduced into Atlas itself.

## 6. Alternatives to a Play listing

| Option | Gives | Costs |
|---|---|---|
| Keep the sideloaded APK (today) | Nothing to do; full feature set including the shared folder | Install by hand; Android developer verification may require a free registration in 2027 (step 5) |
| GitHub Release APK (REL-01 already builds Linux; add APK) | A download link; auto-update not included | Same as above |
| F-Droid / self-hosted F-Droid repo | Store-like updates, no Google account, no reviewer-login issue | Reproducible-build and metadata work; a self-hosted repo needs a signed index |
| Play **internal/closed testing only** (never production) | Updates and installs through Play for up to a small list of testers; the 14-day rule does not apply to staying in a test track **[UNVERIFIED]** | Testers must be added by email; Play still needs the account and a policy-complete app |

## Appendix A - Privacy policy (draft; owner to review before publishing)

> **Atlas privacy policy.** Atlas is a self-hosted application. The Atlas app on your phone connects only to the Atlas server whose address you enter during sign-in; that server is run by you or by someone you trust, not by the developer of the app.
>
> **What the app handles.** Your notes, tasks, projects, calendar entries you import, reminders and the account name and password you use to sign in. These are sent over HTTPS to your server and stored on your phone for offline use. A device key and token are stored in the Android Keystore.
>
> **What the developer receives.** Nothing. The app contains no analytics, advertising, tracking or crash-reporting service and does not contact any server other than yours.
>
> **Notifications.** Reminders are scheduled on the phone using Android alarms. If you enable "Keep Atlas connected", the app keeps its own connection to your server open and shows a notification while it does.
>
> **Backups and sharing.** The app excludes its data from Android cloud backup and device transfer. Nothing is shared with third parties. "Export notes" writes a zip file only where you choose.
>
> **Deleting your data.** Delete notes and tasks in the app (they are removed from your server and phone), sign out to delete the device key, or uninstall the app to remove everything stored on the phone. Data on your server is deleted according to your server's configuration.
>
> **Contact.** `<owner contact email>` **[owner to supply]**. Last updated `<date>`.

## Appendix B - Data safety form (draft answers, **[UNVERIFIED]** until entered in the Console)

| Question | Answer |
|---|---|
| Does the app collect or share user data? | Collects (transmits to the user's own server); **does not share** with third parties |
| Data types transmitted | Personal info: user ID / name and password (authentication); App activity and user-generated content: notes, tasks, projects, calendar entries; App info and performance: none; Device or other IDs: a per-device identifier created by the app for sync |
| Purposes | App functionality; account management |
| Encrypted in transit | Yes (HTTPS only; cleartext is refused except loopback, ADR-0075 D6) |
| Can users request deletion | Yes (in the app; the data is on the user's own server) |
| Ads / analytics | None |
| Collected data optional? | The server connection is required for the app to work |

## Appendix C - Permission justifications (draft text)

- **Exact alarms (`USE_EXACT_ALARM`):** "Atlas is a task and note planner. Users set a reminder time on a task and expect a notification at that exact time, also when the phone is idle or the app is closed. The app schedules one alarm-clock alarm per reminder and re-arms them after reboot. No other use."
- **Foreground service, special use:** "An optional setting, off by default, keeps the app's own connection to the user's self-hosted server open so that reminders and changes made on another device arrive while the app is in the background. A persistent notification is shown while it runs and the user can stop it from Settings."
- **Boot receiver:** "Re-arms the user's pending reminders after a reboot, update or time change."

## Appendix D - Listing copy (draft)

- **Title (30 characters max):** `Atlas Notes & Tasks` (alternative: `Atlas (self-hosted)`).
- **Short description (80 max):** `Markdown notes, tasks and planning that sync with your own self-hosted server.`
- **Long description (outline):** (1) *Requires your own Atlas server* (link to the operator guide); (2) Markdown notes kept as ordinary files; (3) tasks, projects and Kanban with reminders that fire on time; (4) calendar via ICS feeds and file import (Google/Microsoft account sync is not in 0.1.0); (5) offline use, conflict-safe sync; (6) no ads, no analytics, no data sent to the developer; (7) known limits: no push wake-up, no background sync after Android stops the app.
- **Category:** Productivity. **Contact:** owner supplies. **Content rating:** answers for an app with no user-to-user content, violence, or purchases.
- **Graphics:** 512x512 icon (from the Tauri icon source), 1024x500 feature graphic (to design), at least 2 and up to 8 phone screenshots from the demo account.
