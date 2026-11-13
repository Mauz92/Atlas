//! The only code that reads the device token (SYNC-09c). The webview sends a METHOD, a `/api/...` PATH, a few
//! allow-listed headers and a body; the host prepends the configured origin, drops every other header (above
//! all `Authorization` and `Cookie`), attaches `Authorization: Bearer <token from the keystore>`, never follows
//! a redirect (the token must not travel to another origin) and caps the answer size. TLS trusts the platform's
//! certificate store (`rustls-tls-native-roots`: the owner's private CA works once it is in the system store).
use crate::{keystore, rules};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, time::Duration};

pub const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const USER_AGENT: &str = concat!("Atlas-Desktop/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Deserialize)]
pub struct ApiRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ApiResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(USER_AGENT)
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

/// Build and send one request. `token` is attached as the bearer; the webview's own `Authorization` is dropped.
pub async fn request_with_token(base: &str, token: Option<&str>, req: &ApiRequest) -> Result<ApiResponse, String> {
    let base = rules::check_base_url(base)?;
    rules::check_api_path(&req.path)?;
    let method = match req.method.to_ascii_uppercase().as_str() {
        m @ ("GET" | "POST" | "PUT" | "PATCH" | "DELETE") => reqwest::Method::from_bytes(m.as_bytes()).unwrap(),
        _ => return Err("refused: method".into()),
    };
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(30_000).clamp(1_000, 120_000));
    let mut rb = client(timeout)?.request(method, format!("{base}{}", req.path));
    for (k, v) in &req.headers {
        if rules::FORWARDED_HEADERS.contains(&k.to_ascii_lowercase().as_str()) {
            rb = rb.header(k.as_str(), v.as_str());
        }
    }
    if let Some(t) = token {
        rb = rb.bearer_auth(t);
    }
    if let Some(b) = &req.body {
        rb = rb.body(b.clone());
    }
    let resp = rb.send().await.map_err(|e| format!("network: {}", describe(&e)))?;
    let status = resp.status().as_u16();
    let headers = resp.headers().iter().map(|(k, v)| (k.as_str().to_ascii_lowercase(), v.to_str().unwrap_or("").to_string())).collect();
    if resp.content_length().is_some_and(|n| n as usize > MAX_RESPONSE_BYTES) {
        return Err("network: response too large".into());
    }
    let bytes = resp.bytes().await.map_err(|e| format!("network: {}", describe(&e)))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("network: response too large".into());
    }
    Ok(ApiResponse { status, headers, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// Same, with the token read from the OS keystore. A missing token sends the request without one (the server answers 401).
pub async fn request(base: &str, req: &ApiRequest) -> Result<ApiResponse, String> {
    let token = tokio::task::spawn_blocking(keystore::get).await.map_err(|e| e.to_string())??;
    request_with_token(base, token.as_deref(), req).await
}

/// A transport failure without the URL (it never contains a secret, but also never leaks query strings into logs).
fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timeout".into()
    } else if e.is_connect() {
        "connection failed".into()
    } else {
        "request failed".into()
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SignInFailure {
    /// invalid_credentials, rate_limited, unreachable, insecure_url, update_required, keystore_unavailable, server_error
    pub failure: &'static str,
    pub detail: String,
}

/// `POST /api/devices` (ADR-0065). The token goes to `store` (the OS keystore in the app) and is NOT returned:
/// the caller gets the device record and nothing else.
pub async fn sign_in_with(
    base: &str,
    email: &str,
    password: &str,
    device_name: &str,
    store: impl FnOnce(String) -> Result<(), String>,
) -> Result<Value, SignInFailure> {
    let base = rules::check_base_url(base).map_err(|d| SignInFailure { failure: "insecure_url", detail: d })?;
    let platform = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else if cfg!(target_os = "android") { "android" } else { "linux" };
    let body = json!({"email": email, "password": password, "name": device_name, "platform": platform}).to_string();
    let c = client(Duration::from_secs(30)).map_err(|d| SignInFailure { failure: "unreachable", detail: d })?;
    let resp = c
        .post(format!("{base}/api/devices"))
        .header("content-type", "application/json")
        .header("atlas-sync", "1")
        .body(body)
        .send()
        .await
        .map_err(|e| SignInFailure { failure: "unreachable", detail: describe(&e) })?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    match status {
        201 => {}
        401 | 400 | 422 => return Err(SignInFailure { failure: "invalid_credentials", detail: format!("the server answered {status}") }),
        429 => return Err(SignInFailure { failure: "rate_limited", detail: "too many attempts; wait a minute".into() }),
        426 => return Err(SignInFailure { failure: "update_required", detail: "this app is too old for the server".into() }),
        other => return Err(SignInFailure { failure: "server_error", detail: format!("the server answered {other}") }),
    }
    let parsed: Value = serde_json::from_str(&text).map_err(|_| SignInFailure { failure: "server_error", detail: "unreadable answer".into() })?;
    let token = parsed["token"].as_str().ok_or(SignInFailure { failure: "server_error", detail: "no token in the answer".into() })?.to_string();
    store(token).map_err(|d| SignInFailure { failure: "keystore_unavailable", detail: d })?;
    Ok(parsed["device"].clone())
}

pub async fn sign_in(base: &str, email: &str, password: &str, device_name: &str) -> Result<Value, SignInFailure> {
    sign_in_with(base, email, password, device_name, |t| keystore::set(&t)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
        thread,
    };

    /// A one-shot HTTP server on loopback that records the raw request and answers with `reply`.
    fn serve(reply: impl Into<String>) -> (String, Arc<Mutex<String>>) {
        let reply: String = reply.into();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(String::new()));
        let seen2 = seen.clone();
        thread::spawn(move || {
            for stream in listener.incoming().take(4) {
                let mut s = stream.unwrap();
                let mut buf = vec![0u8; 16384];
                let n = s.read(&mut buf).unwrap_or(0);
                *seen2.lock().unwrap() = String::from_utf8_lossy(&buf[..n]).into_owned();
                let _ = s.write_all(reply.as_bytes());
            }
        });
        (base, seen)
    }

    fn answer(status: &str, body: &str) -> String {
        format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len())
    }

    fn req(path: &str, headers: &[(&str, &str)]) -> ApiRequest {
        ApiRequest { method: "GET".into(), path: path.into(), headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), body: None, timeout_ms: Some(5000) }
    }

    #[tokio::test]
    async fn the_host_attaches_the_token_and_drops_the_webviews_credentials() {
        let (base, seen) = serve(answer("200 OK", "{\"ok\":true}"));
        let r = req("/api/changes?since=0", &[("Authorization", "Bearer forged"), ("Cookie", "session=stolen"), ("Host", "evil.example"), ("Atlas-Sync", "1"), ("X-Other", "x")]);
        let out = request_with_token(&base, Some("real-token"), &r).await.unwrap();
        assert_eq!(out.status, 200);
        let raw = seen.lock().unwrap().to_ascii_lowercase();
        assert!(raw.starts_with("get /api/changes?since=0 http/1.1"));
        assert!(raw.contains("authorization: bearer real-token"));
        assert!(!raw.contains("forged") && !raw.contains("stolen") && !raw.contains("evil.example") && !raw.contains("x-other"));
        assert!(raw.contains("atlas-sync: 1"));
    }

    #[tokio::test]
    async fn a_redirect_is_not_followed_so_the_token_stays_on_its_origin() {
        let (base, _) = serve("HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:9/steal\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        let out = request_with_token(&base, Some("t"), &req("/api/x", &[])).await.unwrap();
        assert_eq!(out.status, 302);
    }

    #[tokio::test]
    async fn refuses_other_hosts_paths_and_methods_before_connecting() {
        assert!(request_with_token("http://example.org", Some("t"), &req("/api/x", &[])).await.is_err());
        assert!(request_with_token("http://127.0.0.1:1", Some("t"), &req("/health", &[])).await.is_err());
        let mut r = req("/api/x", &[]);
        r.method = "TRACE".into();
        assert!(request_with_token("http://127.0.0.1:1", Some("t"), &r).await.is_err());
    }

    #[tokio::test]
    async fn sign_in_stores_the_token_and_returns_only_the_device() {
        let (base, seen) = serve(answer("201 Created", "{\"token\":\"tok-123\",\"device\":{\"id\":\"d1\",\"name\":\"Linux desktop\"}}"));
        let stored = Arc::new(Mutex::new(None));
        let s2 = stored.clone();
        let device = sign_in_with(&base, "me@example.org", "pw", "Linux desktop", move |t| {
            *s2.lock().unwrap() = Some(t);
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(device["id"], "d1");
        assert_eq!(stored.lock().unwrap().as_deref(), Some("tok-123"));
        assert!(!device.to_string().contains("tok-123"));
        let raw = seen.lock().unwrap().clone();
        assert!(raw.starts_with("POST /api/devices "));
        assert!(raw.contains("\"email\":\"me@example.org\""));
    }

    #[tokio::test]
    async fn sign_in_failures_are_named() {
        for (reply, want) in [
            ("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n", "invalid_credentials"),
            ("HTTP/1.1 429 Too Many Requests\r\ncontent-length: 0\r\nconnection: close\r\n\r\n", "rate_limited"),
            ("HTTP/1.1 426 Upgrade Required\r\ncontent-length: 0\r\nconnection: close\r\n\r\n", "update_required"),
            ("HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n", "server_error"),
        ] {
            let (base, _) = serve(reply);
            let err = sign_in_with(&base, "a@b.c", "pw", "d", |_| Ok(())).await.unwrap_err();
            assert_eq!(err.failure, want);
        }
        let err = sign_in_with("http://192.0.2.1", "a", "b", "d", |_| Ok(())).await.unwrap_err();
        assert_eq!(err.failure, "insecure_url");
        let (base, _) = serve(answer("201 Created", "{\"token\":\"t\",\"device\":{\"id\":\"d\",\"name\":\"n\"}}"));
        let err = sign_in_with(&base, "a@b.c", "pw", "d", |_| Err("no_storage_access".into())).await.unwrap_err();
        assert_eq!(err.failure, "keystore_unavailable");
    }
}
