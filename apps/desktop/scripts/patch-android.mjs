// The customisation of the generated Android project (idempotent). Everything Atlas needs beyond what `tauri android init` writes:
//  - no cloud backup or device transfer of the app's files (the token ciphertext and the synced database stay on the phone),
//  - the keyboard resizes the page instead of covering the editor,
//  - minSdk 26 (the host plugin's floor: Keystore AES-GCM without compatibility code, notification channels).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const gen = process.argv[2];
if (!gen || !existsSync(gen)) throw new Error("usage: patch-android.mjs <gen/android>");

const manifestPath = path.join(gen, "app/src/main/AndroidManifest.xml");
let manifest = readFileSync(manifestPath, "utf8");
if (!manifest.includes("allowBackup")) {
  manifest = manifest.replace("<application", '<application\n        android:allowBackup="false"\n        android:fullBackupContent="false"\n        android:dataExtractionRules="@xml/data_extraction_rules"');
}
if (!manifest.includes("windowSoftInputMode")) {
  manifest = manifest.replace('android:launchMode="singleTask"', 'android:launchMode="singleTask"\n            android:windowSoftInputMode="adjustResize"');
}
writeFileSync(manifestPath, manifest);

const xmlDir = path.join(gen, "app/src/main/res/xml");
mkdirSync(xmlDir, { recursive: true });
const all = ["root", "file", "database", "sharedpref"].map((d) => `<exclude domain="${d}" />`).join("");
writeFileSync(
  path.join(xmlDir, "data_extraction_rules.xml"),
  `<?xml version="1.0" encoding="utf-8"?>\n<!-- Atlas keeps the device token ciphertext and the synced database on the phone: no cloud backup, no device transfer (ADR-0075). -->\n<data-extraction-rules>\n    <cloud-backup>${all}</cloud-backup>\n    <device-transfer>${all}</device-transfer>\n</data-extraction-rules>\n`,
);

const gradlePath = path.join(gen, "app/build.gradle.kts");
let gradle = readFileSync(gradlePath, "utf8").replace(/minSdk = \d+/, "minSdk = 26");
// Release signing with the owner's key (`scripts/android-keystore.sh` creates it under apps/desktop/keys/, which is gitignored). Without the
// properties file the release build is unsigned (Gradle then refuses to produce an installable APK, which is the safe outcome).
if (!gradle.includes("atlasRelease")) {
  const props = path.resolve(gen, "../../../keys/android-signing.properties").replaceAll("\\", "/");
  gradle = gradle.replace(
    "    buildTypes {",
    `    val signingProps = Properties().apply {
        val f = file("${props}")
        if (f.exists()) f.inputStream().use { load(it) }
    }
    signingConfigs {
        if (signingProps.isNotEmpty()) {
            create("atlasRelease") {
                storeFile = file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }
    buildTypes {`,
  );
  gradle = gradle.replace('getByName("release") {', 'getByName("release") {\n            if (signingProps.isNotEmpty()) signingConfig = signingConfigs.getByName("atlasRelease")');
}
// Tauri's Android runtime pulls Jackson 2.15.3, which has published advisories (GHSA-72hv-8253-57qq and 14 more, found by an OSV scan of the release
// classpath on 2026-11-12); 2.22.4 has none. Forced for the whole app (the host parses the page's alarm arguments with it).
if (!gradle.includes("jackson-databind:2.22.4")) {
  gradle += `
configurations.all {
    resolutionStrategy {
        force("com.fasterxml.jackson.core:jackson-databind:2.22.4", "com.fasterxml.jackson.core:jackson-core:2.22.4")
    }
}
`;
}
writeFileSync(gradlePath, gradle);
console.log("patched", gen);
