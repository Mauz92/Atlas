//! Input rules the host enforces however the webview behaves.

/// The API base URL rule (SYNC_PROTOCOL 10.1): `https`, or `http` only for a loopback host; an origin
/// only (no credentials, path, query or fragment). Returns the normalised origin without a trailing slash.
pub fn check_base_url(input: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(input.trim()).map_err(|_| "not a valid URL".to_string())?;
    let loopback = matches!(url.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"));
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err("insecure_url: the server address must start with https:// (http:// only for localhost)".into()),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("insecure_url: no user name or password in the address".into());
    }
    if (url.path() != "/" && !url.path().is_empty()) || url.query().is_some() || url.fragment().is_some() {
        return Err("insecure_url: give the address of the server only".into());
    }
    Ok(url.origin().ascii_serialization())
}

/// A request path from the webview: `/api/...`, nothing that could change the host or climb out of `/api`.
pub fn check_api_path(path: &str) -> Result<(), String> {
    if !path.starts_with("/api/") || path.starts_with("/api//") {
        return Err("refused: path must start with /api/".into());
    }
    if path.len() > 4096 || path.chars().any(|c| c.is_control() || c == '\\' || c == ' ') {
        return Err("refused: unusual characters in path".into());
    }
    let route = path.split(['?', '#']).next().unwrap_or("");
    if route.contains('@') {
        return Err("refused: '@' in route".into());
    }
    if route.split('/').any(|s| s == ".." || s == "." || s.eq_ignore_ascii_case("%2e%2e") || s.eq_ignore_ascii_case("%2e")) {
        return Err("refused: path traversal".into());
    }
    if path.contains('#') {
        return Err("refused: fragment in path".into());
    }
    Ok(())
}

/// Request headers the webview may set. Everything else (Authorization, Cookie, Host, Origin, ...) is dropped.
pub const FORWARDED_HEADERS: &[&str] = &["content-type", "accept", "atlas-sync", "atlas-epoch", "idempotency-key", "if-none-match", "x-csrf-token"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_accepts_https_and_loopback_http() {
        assert_eq!(check_base_url("https://atlas.example.org/").unwrap(), "https://atlas.example.org");
        assert_eq!(check_base_url("http://127.0.0.1:18000").unwrap(), "http://127.0.0.1:18000");
        assert_eq!(check_base_url("http://localhost:8000/").unwrap(), "http://localhost:8000");
    }

    #[test]
    fn base_url_refuses_everything_else() {
        for bad in [
            "http://atlas.example.org",
            "http://192.168.1.5:8000",
            "http://localhost.evil.example",
            "ftp://atlas.example.org",
            "https://u:p@atlas.example.org",
            "https://atlas.example.org/api",
            "https://atlas.example.org/?a=1",
            "atlas.example.org",
            "",
        ] {
            assert!(check_base_url(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn api_paths_are_confined() {
        assert!(check_api_path("/api/changes?since=0&limit=100").is_ok());
        assert!(check_api_path("/api/notes/3f2a/history").is_ok());
        for bad in ["/health", "api/x", "//evil.example/api/x", "/api//x", "/api/../admin", "/api/x\r\nHost: evil", "/api/x@evil", "/api/%2e%2e/x", "/api/a#b", "/api/a b"] {
            assert!(check_api_path(bad).is_err(), "{bad:?} should be refused");
        }
    }
}
