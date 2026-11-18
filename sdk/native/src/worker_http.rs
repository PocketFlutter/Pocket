//! Zero-dependency HTTP/1.1 & URL adapter with cross-platform Host Dio FFI bridge.
//!
//! Eliminates `ureq`, `rustls`, `ring`, `webpki`, `url`, `idna`, and `icu_*`
//! (~3.5+ MB per native target across iOS, Android, macOS, Windows, and Linux):
//! - Production Flutter hosts delegate HTTP(S) hops to `dio` via C-FFI
//!   (`pocket_register_worker_http_bridge` / `pocket_complete_worker_http_request`),
//!   reusing each platform's OS TLS stack (`NSURLSession`, BoringSSL, Schannel).
//! - Standalone probes and Rust unit tests execute plain `http://` directly
//!   over `std::net::TcpStream` with 1-socket keep-alive pooling and strict
//!   total-budget deadlines.

use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::io::{self, ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::slice;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_HEADER_BLOCK_BYTES: usize = 16 * 1024;
const SOCKET_SLICE: Duration = Duration::from_millis(40);

/// Minimal RFC 3986 / WHATWG-aligned HTTP(S) URL representation in pure `std`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Url {
    raw: String,
    scheme: String,
    username: String,
    password: Option<String>,
    has_userinfo: bool,
    host: String,
    port: Option<u16>,
    path: String,
    query: Option<String>,
    fragment: Option<String>,
}

impl Url {
    pub fn parse(input: &str) -> Result<Self, String> {
        if input.is_empty() || input.len() > 8192 {
            return Err("URL is empty or exceeds 8192 bytes".to_owned());
        }
        if input
            .bytes()
            .any(|byte| byte <= 0x20 || byte == 0x7f)
        {
            return Err("URL contains control or whitespace characters".to_owned());
        }
        let (before_frag, fragment) = match input.find('#') {
            Some(idx) => (&input[..idx], Some(input[idx + 1..].to_owned())),
            None => (input, None),
        };
        let Some(scheme_sep) = before_frag.find("://") else {
            return Err("URL is missing scheme://".to_owned());
        };
        let raw_scheme = &before_frag[..scheme_sep];
        if !valid_scheme(raw_scheme) {
            return Err("invalid URL scheme".to_owned());
        }
        let scheme = raw_scheme.to_ascii_lowercase();
        let rest = &before_frag[scheme_sep + 3..];
        let auth_end = rest.find(['/', '?']).unwrap_or(rest.len());
        let authority = &rest[..auth_end];
        let after_auth = &rest[auth_end..];
        let (raw_path, query) = match after_auth.find('?') {
            Some(idx) => (&after_auth[..idx], Some(after_auth[idx + 1..].to_owned())),
            None => (after_auth, None),
        };
        let (has_userinfo, username, password, host_port) = match authority.rfind('@') {
            Some(idx) => {
                let ui = &authority[..idx];
                let hp = &authority[idx + 1..];
                let (user, pass) = match ui.find(':') {
                    Some(colon) => (ui[..colon].to_owned(), Some(ui[colon + 1..].to_owned())),
                    None => (ui.to_owned(), None),
                };
                (true, user, pass, hp)
            }
            None => (false, String::new(), None, authority),
        };
        let (host, parsed_port) = parse_host_port(host_port)?;
        let port = match (scheme.as_str(), parsed_port) {
            ("http", Some(80)) | ("https", Some(443)) => None,
            (_, other) => other,
        };
        let path = if raw_path.is_empty() {
            "/".to_owned()
        } else {
            normalize_path(raw_path)
        };
        Ok(Self::build(
            scheme,
            has_userinfo,
            username,
            password,
            host,
            port,
            path,
            query,
            fragment,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn build(
        scheme: String,
        has_userinfo: bool,
        username: String,
        password: Option<String>,
        host: String,
        port: Option<u16>,
        path: String,
        query: Option<String>,
        fragment: Option<String>,
    ) -> Self {
        let mut raw = String::with_capacity(
            scheme.len() + 3 + host.len() + path.len() + query.as_ref().map_or(0, |q| q.len() + 1),
        );
        raw.push_str(&scheme);
        raw.push_str("://");
        if has_userinfo {
            raw.push_str(&username);
            if let Some(pw) = &password {
                raw.push(':');
                raw.push_str(pw);
            }
            raw.push('@');
        }
        raw.push_str(&host);
        if let Some(p) = port {
            raw.push(':');
            raw.push_str(&p.to_string());
        }
        raw.push_str(&path);
        if let Some(q) = &query {
            raw.push('?');
            raw.push_str(q);
        }
        if let Some(f) = &fragment {
            raw.push('#');
            raw.push_str(f);
        }
        Self {
            raw,
            scheme,
            username,
            password,
            has_userinfo,
            host,
            port,
            path,
            query,
            fragment,
        }
    }

    pub fn scheme(&self) -> &str {
        &self.scheme
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    pub fn password(&self) -> Option<&str> {
        self.password.as_deref()
    }

    pub fn has_credentials(&self) -> bool {
        self.has_userinfo || !self.username.is_empty() || self.password.is_some()
    }

    pub fn host_str(&self) -> Option<&str> {
        (!self.host.is_empty()).then_some(self.host.as_str())
    }

    pub fn connect_host(&self) -> &str {
        if self.host.starts_with('[') && self.host.ends_with(']') && self.host.len() > 2 {
            &self.host[1..self.host.len() - 1]
        } else {
            &self.host
        }
    }

    pub fn effective_port(&self) -> Option<u16> {
        self.port.or(match self.scheme.as_str() {
            "http" => Some(80),
            "https" => Some(443),
            _ => None,
        })
    }

    pub fn host_header(&self) -> String {
        match self.port {
            Some(port) => format!("{}:{port}", self.host),
            None => self.host.clone(),
        }
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn query(&self) -> Option<&str> {
        self.query.as_deref()
    }

    pub fn fragment(&self) -> Option<&str> {
        self.fragment.as_deref()
    }

    pub fn as_str(&self) -> &str {
        &self.raw
    }

    pub fn request_target(&self) -> String {
        match &self.query {
            Some(q) => format!("{}?{q}", self.path),
            None => self.path.clone(),
        }
    }

    pub fn origin_ascii(&self) -> String {
        match self.scheme.as_str() {
            "http" | "https" => match self.port {
                Some(port) => format!("{}://{}:{port}", self.scheme, self.host),
                None => format!("{}://{}", self.scheme, self.host),
            },
            _ => "null".to_owned(),
        }
    }

    pub fn join(&self, location: &str) -> Result<Self, String> {
        if location.is_empty() {
            return Ok(self.clone());
        }
        if location.bytes().any(|byte| byte <= 0x20 || byte == 0x7f) {
            return Err("redirect location contains control or whitespace characters".to_owned());
        }
        if location.contains("://") {
            return Self::parse(location);
        }
        if location.starts_with("//") {
            return Self::parse(&format!("{}:{location}", self.scheme));
        }
        let (before_frag, fragment) = match location.find('#') {
            Some(idx) => (&location[..idx], Some(location[idx + 1..].to_owned())),
            None => (location, None),
        };
        let (rel_path, query) = match before_frag.find('?') {
            Some(idx) => (&before_frag[..idx], Some(before_frag[idx + 1..].to_owned())),
            None => (before_frag, None),
        };
        let (next_path, next_query) = if rel_path.is_empty() {
            (
                self.path.clone(),
                query.or_else(|| self.query.clone()),
            )
        } else if rel_path.starts_with('/') {
            (normalize_path(rel_path), query)
        } else {
            let base_dir = match self.path.rfind('/') {
                Some(idx) => &self.path[..=idx],
                None => "/",
            };
            (normalize_path(&format!("{base_dir}{rel_path}")), query)
        };
        Ok(Self::build(
            self.scheme.clone(),
            false,
            String::new(),
            None,
            self.host.clone(),
            self.port,
            next_path,
            next_query,
            fragment,
        ))
    }
}

fn valid_scheme(raw: &str) -> bool {
    let mut bytes = raw.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphabetic())
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
}

fn parse_host_port(host_port: &str) -> Result<(String, Option<u16>), String> {
    if host_port.is_empty() {
        return Err("URL host is empty".to_owned());
    }
    if host_port.starts_with('[') {
        let Some(close) = host_port.find(']') else {
            return Err("unclosed IPv6 bracket in host".to_owned());
        };
        let inner = &host_port[1..close];
        if inner.is_empty()
            || !inner
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || matches!(b, b':' | b'.'))
        {
            return Err("invalid IPv6 host literal".to_owned());
        }
        let host = host_port[..=close].to_ascii_lowercase();
        let after = &host_port[close + 1..];
        let port = if after.is_empty() {
            None
        } else if let Some(port_str) = after.strip_prefix(':') {
            parse_port(port_str)?
        } else {
            return Err("unexpected characters after IPv6 literal".to_owned());
        };
        return Ok((host, port));
    }
    let (raw_host, port) = match host_port.find(':') {
        Some(colon) => {
            let h = &host_port[..colon];
            let p = &host_port[colon + 1..];
            if p.contains(':') {
                return Err("unbracketed IPv6 address in host".to_owned());
            }
            (h, parse_port(p)?)
        }
        None => (host_port, None),
    };
    if raw_host.is_empty()
        || raw_host.bytes().any(|b| {
            b <= 0x20
                || b >= 0x7f
                || matches!(b, b'/' | b'?' | b'#' | b'@' | b'\\' | b'[' | b']')
        })
    {
        return Err("invalid ASCII host".to_owned());
    }
    Ok((raw_host.to_ascii_lowercase(), port))
}

fn parse_port(port_str: &str) -> Result<Option<u16>, String> {
    if port_str.is_empty() {
        return Ok(None);
    }
    let port = port_str
        .parse::<u16>()
        .map_err(|_| "invalid port number".to_owned())?;
    if port == 0 {
        return Err("port 0 is not allowed in HTTP URLs".to_owned());
    }
    Ok(Some(port))
}

fn normalize_path(raw_path: &str) -> String {
    let trailing_slash = raw_path.ends_with('/')
        || raw_path.ends_with("/.")
        || raw_path.ends_with("/..");
    let mut stack: Vec<&str> = Vec::new();
    for seg in raw_path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    if stack.is_empty() {
        return "/".to_owned();
    }
    let mut out = String::with_capacity(raw_path.len() + 1);
    for seg in stack {
        out.push('/');
        out.push_str(seg);
    }
    if trailing_slash && !out.ends_with('/') {
        out.push('/');
    }
    out
}

// ============================================================================
// Cross-Platform Host Dio HTTP Bridge (C ABI)
// ============================================================================

pub type WorkerHostHttpCallback = unsafe extern "C" fn(
    request_id: u64,
    request_json_ptr: *const u8,
    request_json_len: usize,
);

struct HostBridgeResponse {
    status: u16,
    final_url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    error: Option<String>,
}

struct PendingHostRequest {
    result: Mutex<Option<HostBridgeResponse>>,
    cv: Condvar,
}

struct HostBridgeRegistry {
    callback: Mutex<Option<WorkerHostHttpCallback>>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Arc<PendingHostRequest>>>,
}

fn host_bridge() -> &'static HostBridgeRegistry {
    static REGISTRY: OnceLock<HostBridgeRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| HostBridgeRegistry {
        callback: Mutex::new(None),
        next_id: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
    })
}

/// Registers (or clears when `callback` is `None`) the host HTTP transport
/// callback (wired on Flutter to `dio` across iOS, Android, macOS, Windows, Linux).
#[no_mangle]
pub unsafe extern "C" fn pocket_register_worker_http_bridge(
    callback: Option<WorkerHostHttpCallback>,
) {
    let mut guard = host_bridge()
        .callback
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *guard = callback;
}

/// Completes a pending Worker HTTP hop executed by the host `dio` client.
#[no_mangle]
pub unsafe extern "C" fn pocket_complete_worker_http_request(
    request_id: u64,
    status: i32,
    final_url_ptr: *const u8,
    final_url_len: usize,
    headers_json_ptr: *const u8,
    headers_json_len: usize,
    body_ptr: *const u8,
    body_len: usize,
    error_ptr: *const u8,
    error_len: usize,
) {
    let entry = host_bridge()
        .pending
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .remove(&request_id);
    let Some(pending) = entry else {
        return;
    };
    let error = if error_len > 0 && !error_ptr.is_null() {
        Some(
            String::from_utf8_lossy(unsafe { slice::from_raw_parts(error_ptr, error_len) })
                .into_owned(),
        )
    } else {
        None
    };
    let final_url = if final_url_len > 0 && !final_url_ptr.is_null() {
        String::from_utf8_lossy(unsafe { slice::from_raw_parts(final_url_ptr, final_url_len) })
            .into_owned()
    } else {
        String::new()
    };
    let headers = if headers_json_len > 0 && !headers_json_ptr.is_null() {
        let bytes = unsafe { slice::from_raw_parts(headers_json_ptr, headers_json_len) };
        serde_json::from_slice::<BTreeMap<String, String>>(bytes)
            .map(|map| map.into_iter().collect::<Vec<_>>())
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let body = if body_len > 0 && !body_ptr.is_null() {
        unsafe { slice::from_raw_parts(body_ptr, body_len) }.to_vec()
    } else {
        Vec::new()
    };
    let response = HostBridgeResponse {
        status: status.clamp(0, 999) as u16,
        final_url,
        headers,
        body,
        error,
    };
    *pending
        .result
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = Some(response);
    pending.cv.notify_all();
}

pub fn has_host_http_bridge() -> bool {
    host_bridge()
        .callback
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .is_some()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostBridgeRequestPayload<'a> {
    url: &'a str,
    method: &'a str,
    headers: &'a BTreeMap<String, String>,
    body: Option<&'a str>,
    timeout_ms: u64,
    max_bytes: usize,
}

// ============================================================================
// Lightweight HTTP/1.1 Agent + Pooled Keep-Alive Socket
// ============================================================================

#[derive(Default)]
pub struct HttpPool {
    idle: Mutex<Option<(String, TcpStream)>>,
}

impl HttpPool {
    fn take(&self, origin: &str) -> Option<TcpStream> {
        let mut guard = self
            .idle
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if guard.as_ref().is_some_and(|(key, _)| key == origin) {
            guard.take().map(|(_, stream)| stream)
        } else {
            None
        }
    }

    fn put(&self, origin: String, stream: TcpStream) {
        let mut guard = self
            .idle
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *guard = Some((origin, stream));
    }
}

#[derive(Clone)]
pub struct HttpAgent {
    pool: Option<Arc<HttpPool>>,
    connect_timeout: Duration,
    total_timeout: Option<Duration>,
}

impl HttpAgent {
    pub fn pooled(connect_timeout: Duration) -> Self {
        Self {
            pool: Some(Arc::new(HttpPool::default())),
            connect_timeout,
            total_timeout: None,
        }
    }

    pub fn oneshot(budget: Duration) -> Self {
        Self {
            pool: None,
            connect_timeout: budget,
            total_timeout: Some(budget),
        }
    }

    pub fn request(&self, method: &str, url: &str) -> HttpRequestBuilder {
        HttpRequestBuilder {
            agent: self.clone(),
            method: method.to_owned(),
            url: url.to_owned(),
            headers: BTreeMap::new(),
            timeout: self.total_timeout,
            cancel: None,
            max_bytes_hint: 256 * 1024,
        }
    }

    pub fn get(&self, url: &str) -> HttpRequestBuilder {
        self.request("GET", url)
    }
}

pub struct HttpRequestBuilder {
    agent: HttpAgent,
    method: String,
    url: String,
    headers: BTreeMap<String, String>,
    timeout: Option<Duration>,
    cancel: Option<Arc<AtomicBool>>,
    max_bytes_hint: usize,
}

impl HttpRequestBuilder {
    pub fn timeout(mut self, duration: Duration) -> Self {
        self.timeout = Some(duration);
        self
    }

    pub fn cancel_token(mut self, cancel: Arc<AtomicBool>) -> Self {
        self.cancel = Some(cancel);
        self
    }

    pub fn max_bytes_hint(mut self, max_bytes: usize) -> Self {
        self.max_bytes_hint = max_bytes;
        self
    }

    pub fn set(mut self, name: &str, value: &str) -> Self {
        self.headers.insert(name.to_ascii_lowercase(), value.to_owned());
        self
    }

    pub fn call(self) -> Result<HttpResponse, String> {
        self.execute(None)
    }

    pub fn send_string(self, body: &str) -> Result<HttpResponse, String> {
        self.execute(Some(body))
    }

    fn execute(self, body: Option<&str>) -> Result<HttpResponse, String> {
        let parsed = Url::parse(&self.url)?;
        let budget = self
            .timeout
            .unwrap_or_else(|| Duration::from_secs(30))
            .max(Duration::from_millis(1));
        let deadline = Instant::now() + budget;

        let callback = *host_bridge()
            .callback
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(cb) = callback {
            return execute_via_host_bridge(
                cb,
                &parsed,
                &self.method,
                &self.headers,
                body,
                budget,
                deadline,
                self.max_bytes_hint,
                self.cancel.as_deref(),
            );
        }

        if parsed.scheme() == "https" {
            return Err(
                "HTTPS requires the host Dio HTTP bridge (register PocketDioWorkerHttpBridge)"
                    .to_owned(),
            );
        }
        if parsed.scheme() != "http" {
            return Err(format!("unsupported HTTP scheme {}", parsed.scheme()));
        }
        execute_plain_http(
            &self.agent,
            &parsed,
            &self.method,
            &self.headers,
            body,
            deadline,
            self.cancel,
        )
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_via_host_bridge(
    callback: WorkerHostHttpCallback,
    url: &Url,
    method: &str,
    headers: &BTreeMap<String, String>,
    body: Option<&str>,
    budget: Duration,
    deadline: Instant,
    max_bytes_hint: usize,
    cancel: Option<&AtomicBool>,
) -> Result<HttpResponse, String> {
    let registry = host_bridge();
    let request_id = registry.next_id.fetch_add(1, Ordering::Relaxed);
    let pending = Arc::new(PendingHostRequest {
        result: Mutex::new(None),
        cv: Condvar::new(),
    });
    registry
        .pending
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .insert(request_id, Arc::clone(&pending));

    let payload = HostBridgeRequestPayload {
        url: url.as_str(),
        method,
        headers,
        body,
        timeout_ms: budget.as_millis().clamp(1, 120_000) as u64,
        max_bytes: max_bytes_hint,
    };
    let encoded = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    unsafe {
        callback(request_id, encoded.as_ptr(), encoded.len());
    }

    let mut guard = pending
        .result
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    while guard.is_none() {
        if cancel.is_some_and(|c| c.load(Ordering::Acquire)) {
            drop(guard);
            registry
                .pending
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remove(&request_id);
            return Err("HTTP request cancelled".to_owned());
        }
        let now = Instant::now();
        if now >= deadline {
            drop(guard);
            registry
                .pending
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remove(&request_id);
            return Err("HTTP request timed out".to_owned());
        }
        let wait = (deadline - now).min(SOCKET_SLICE);
        let (next, _) = pending
            .cv
            .wait_timeout(guard, wait)
            .unwrap_or_else(|poison| poison.into_inner());
        guard = next;
    }
    let completed = guard.take().unwrap();
    if let Some(error) = completed.error {
        return Err(error);
    }
    let final_url = if completed.final_url.is_empty() {
        url.as_str().to_owned()
    } else {
        completed.final_url
    };
    Ok(HttpResponse {
        status: completed.status,
        url: final_url,
        headers: completed.headers,
        reader: HttpBodySource::Memory {
            bytes: completed.body,
            pos: 0,
            deadline,
            cancel: cancel.map(|_| Arc::new(AtomicBool::new(false))),
        },
    })
}

fn execute_plain_http(
    agent: &HttpAgent,
    url: &Url,
    method: &str,
    headers: &BTreeMap<String, String>,
    body: Option<&str>,
    deadline: Instant,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<HttpResponse, String> {
    let origin = url.origin_ascii();
    let keep_alive_desired = agent.pool.is_some();

    if let Some(pool) = &agent.pool {
        if let Some(reused) = pool.take(&origin) {
            match send_and_read_head(
                reused,
                url,
                method,
                headers,
                body,
                keep_alive_desired,
                agent.pool.clone(),
                &origin,
                deadline,
                cancel.clone(),
            ) {
                Ok(resp) => return Ok(resp),
                Err(AttemptError::StalePooledConnection) => {
                    // Server closed idle keep-alive socket; fall through to fresh connect.
                }
                Err(AttemptError::Fatal(err)) => return Err(err),
            }
        }
    }

    check_alive(cancel.as_deref(), deadline)?;
    let now = Instant::now();
    let remaining = deadline
        .saturating_duration_since(now)
        .min(agent.connect_timeout)
        .max(Duration::from_millis(1));
    let port = url.effective_port().unwrap_or(80);
    let host = url.connect_host();
    let mut addrs = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("DNS resolution failed: {error}"))?;
    let Some(sock_addr) = addrs.next() else {
        return Err("no socket address resolved".to_owned());
    };
    let stream = TcpStream::connect_timeout(&sock_addr, remaining)
        .map_err(|error| format!("TCP connect failed: {error}"))?;
    let _ = stream.set_nodelay(true);

    match send_and_read_head(
        stream,
        url,
        method,
        headers,
        body,
        keep_alive_desired,
        agent.pool.clone(),
        &origin,
        deadline,
        cancel,
    ) {
        Ok(resp) => Ok(resp),
        Err(AttemptError::StalePooledConnection) => {
            Err("server closed connection before response headers".to_owned())
        }
        Err(AttemptError::Fatal(err)) => Err(err),
    }
}

enum AttemptError {
    StalePooledConnection,
    Fatal(String),
}

#[allow(clippy::too_many_arguments)]
fn send_and_read_head(
    mut stream: TcpStream,
    url: &Url,
    method: &str,
    headers: &BTreeMap<String, String>,
    body: Option<&str>,
    keep_alive_desired: bool,
    pool: Option<Arc<HttpPool>>,
    origin: &str,
    deadline: Instant,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<HttpResponse, AttemptError> {
    let body_bytes = body.map(str::as_bytes).unwrap_or(&[]);
    let mut wire = Vec::with_capacity(256 + body_bytes.len());
    wire.extend_from_slice(method.as_bytes());
    wire.push(b' ');
    wire.extend_from_slice(url.request_target().as_bytes());
    wire.extend_from_slice(b" HTTP/1.1\r\nHost: ");
    wire.extend_from_slice(url.host_header().as_bytes());
    wire.extend_from_slice(b"\r\nConnection: ");
    wire.extend_from_slice(if keep_alive_desired {
        b"keep-alive\r\n"
    } else {
        b"close\r\n"
    });
    if !headers.contains_key("accept-encoding") {
        wire.extend_from_slice(b"Accept-Encoding: identity\r\n");
    }
    if body.is_some() || matches!(method, "POST" | "PUT" | "PATCH") {
        wire.extend_from_slice(format!("Content-Length: {}\r\n", body_bytes.len()).as_bytes());
    }
    for (name, value) in headers {
        wire.extend_from_slice(name.as_bytes());
        wire.extend_from_slice(b": ");
        wire.extend_from_slice(value.as_bytes());
        wire.extend_from_slice(b"\r\n");
    }
    wire.extend_from_slice(b"\r\n");
    wire.extend_from_slice(body_bytes);

    let mut written = 0usize;
    while written < wire.len() {
        check_alive(cancel.as_deref(), deadline).map_err(AttemptError::Fatal)?;
        let slice_budget = deadline
            .saturating_duration_since(Instant::now())
            .min(SOCKET_SLICE)
            .max(Duration::from_millis(1));
        let _ = stream.set_write_timeout(Some(slice_budget));
        match stream.write(&wire[written..]) {
            Ok(0) => {
                return if written == 0 {
                    Err(AttemptError::StalePooledConnection)
                } else {
                    Err(AttemptError::Fatal("socket closed during HTTP write".to_owned()))
                };
            }
            Ok(n) => written += n,
            Err(err)
                if matches!(
                    err.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) =>
            {
                continue;
            }
            Err(err) if written == 0 => {
                let _ = err;
                return Err(AttemptError::StalePooledConnection);
            }
            Err(err) => return Err(AttemptError::Fatal(format!("HTTP write failed: {err}"))),
        }
    }

    let mut head_buf = Vec::with_capacity(1024);
    let mut temp = [0u8; 1024];
    let header_end = loop {
        check_alive(cancel.as_deref(), deadline).map_err(AttemptError::Fatal)?;
        let slice_budget = deadline
            .saturating_duration_since(Instant::now())
            .min(SOCKET_SLICE)
            .max(Duration::from_millis(1));
        let _ = stream.set_read_timeout(Some(slice_budget));
        match stream.read(&mut temp) {
            Ok(0) => {
                return if head_buf.is_empty() {
                    Err(AttemptError::StalePooledConnection)
                } else {
                    Err(AttemptError::Fatal(
                        "unexpected EOF while reading HTTP headers".to_owned(),
                    ))
                };
            }
            Ok(n) => {
                head_buf.extend_from_slice(&temp[..n]);
                if let Some(pos) = find_header_end(&head_buf) {
                    break pos;
                }
                if head_buf.len() > MAX_HEADER_BLOCK_BYTES {
                    return Err(AttemptError::Fatal(
                        "HTTP response headers exceed 16 KiB".to_owned(),
                    ));
                }
            }
            Err(err)
                if matches!(
                    err.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) =>
            {
                continue;
            }
            Err(err) if head_buf.is_empty() => {
                let _ = err;
                return Err(AttemptError::StalePooledConnection);
            }
            Err(err) => return Err(AttemptError::Fatal(format!("HTTP read failed: {err}"))),
        }
    };

    let raw_headers = &head_buf[..header_end];
    let prefetched = head_buf[header_end + 4..].to_vec();
    let header_text = std::str::from_utf8(raw_headers)
        .map_err(|_| AttemptError::Fatal("HTTP headers are not valid UTF-8".to_owned()))?;
    let mut lines = header_text.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| AttemptError::Fatal("missing HTTP status line".to_owned()))?;
    let (http_11, status) = parse_status_line(status_line).map_err(AttemptError::Fatal)?;

    let mut headers_vec = Vec::new();
    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    let mut conn_close = false;
    let mut conn_keep_alive = false;

    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some(colon) = line.find(':') else {
            continue;
        };
        let name = line[..colon].trim();
        let value = line[colon + 1..].trim();
        if name.eq_ignore_ascii_case("content-length") {
            let parsed_len = value
                .parse::<usize>()
                .map_err(|_| AttemptError::Fatal("invalid Content-Length header".to_owned()))?;
            content_length = Some(parsed_len);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            if value
                .split(',')
                .any(|tok| tok.trim().eq_ignore_ascii_case("chunked"))
            {
                chunked = true;
            }
        } else if name.eq_ignore_ascii_case("connection") {
            for tok in value.split(',') {
                let t = tok.trim();
                if t.eq_ignore_ascii_case("close") {
                    conn_close = true;
                } else if t.eq_ignore_ascii_case("keep-alive") {
                    conn_keep_alive = true;
                }
            }
        }
        headers_vec.push((name.to_owned(), value.to_owned()));
    }

    let mut can_keep_alive = keep_alive_desired
        && !conn_close
        && (http_11 || conn_keep_alive);

    let framing = if method == "HEAD" || (100..200).contains(&status) || status == 204 || status == 304 {
        BodyFraming::Fixed(0)
    } else if chunked {
        BodyFraming::Chunked {
            chunk_remaining: 0,
            eof: false,
        }
    } else if let Some(len) = content_length {
        BodyFraming::Fixed(len)
    } else {
        can_keep_alive = false;
        BodyFraming::UntilEof
    };

    let mut stream_opt = Some(stream);
    let mut pool_return = if can_keep_alive {
        pool.map(|p| (p, origin.to_owned()))
    } else {
        None
    };

    if matches!(framing, BodyFraming::Fixed(0)) && prefetched.is_empty() {
        if let (Some((p, orig)), Some(s)) = (pool_return.take(), stream_opt.take()) {
            p.put(orig, s);
        }
    }

    Ok(HttpResponse {
        status,
        url: url.as_str().to_owned(),
        headers: headers_vec,
        reader: HttpBodySource::Socket(SocketBodyReader {
            stream: stream_opt,
            pool_return,
            buf: prefetched,
            buf_pos: 0,
            framing,
            deadline,
            cancel,
        }),
    })
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_status_line(line: &str) -> Result<(bool, u16), String> {
    let mut parts = line.split_whitespace();
    let proto = parts
        .next()
        .ok_or_else(|| "missing HTTP protocol version".to_owned())?;
    let http_11 = match proto {
        "HTTP/1.1" => true,
        "HTTP/1.0" => false,
        _ => return Err(format!("unsupported HTTP protocol {proto:?}")),
    };
    let code = parts
        .next()
        .ok_or_else(|| "missing HTTP status code".to_owned())?
        .parse::<u16>()
        .map_err(|_| "invalid HTTP status code".to_owned())?;
    if !(100..=599).contains(&code) {
        return Err(format!("HTTP status code {code} out of range"));
    }
    Ok((http_11, code))
}

fn check_alive(cancel: Option<&AtomicBool>, deadline: Instant) -> Result<(), String> {
    if cancel.is_some_and(|c| c.load(Ordering::Acquire)) {
        return Err("HTTP request cancelled".to_owned());
    }
    if Instant::now() >= deadline {
        return Err("HTTP request timed out".to_owned());
    }
    Ok(())
}

pub struct HttpResponse {
    status: u16,
    url: String,
    headers: Vec<(String, String)>,
    reader: HttpBodySource,
}

impl std::fmt::Debug for HttpResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpResponse")
            .field("status", &self.status)
            .field("url", &self.url)
            .finish()
    }
}

impl HttpResponse {
    pub fn status(&self) -> u16 {
        self.status
    }

    pub fn get_url(&self) -> &str {
        &self.url
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn headers_names(&self) -> Vec<String> {
        let mut names = Vec::with_capacity(self.headers.len());
        for (k, _) in &self.headers {
            if !names.iter().any(|existing: &String| existing.eq_ignore_ascii_case(k)) {
                names.push(k.clone());
            }
        }
        names
    }

    pub fn into_reader(self) -> HttpBodyReader {
        HttpBodyReader(self.reader)
    }
}

enum BodyFraming {
    Fixed(usize),
    Chunked { chunk_remaining: usize, eof: bool },
    UntilEof,
}

enum HttpBodySource {
    Memory {
        bytes: Vec<u8>,
        pos: usize,
        deadline: Instant,
        cancel: Option<Arc<AtomicBool>>,
    },
    Socket(SocketBodyReader),
}

pub struct HttpBodyReader(HttpBodySource);

impl Read for HttpBodyReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        match &mut self.0 {
            HttpBodySource::Memory {
                bytes,
                pos,
                deadline,
                cancel,
            } => {
                if cancel.as_ref().is_some_and(|c| c.load(Ordering::Acquire)) {
                    return Err(io::Error::other("HTTP request cancelled"));
                }
                if Instant::now() >= *deadline {
                    return Err(io::Error::other("HTTP request timed out"));
                }
                if *pos >= bytes.len() {
                    return Ok(0);
                }
                let count = (bytes.len() - *pos).min(out.len());
                out[..count].copy_from_slice(&bytes[*pos..*pos + count]);
                *pos += count;
                Ok(count)
            }
            HttpBodySource::Socket(reader) => reader.read_into(out),
        }
    }
}

struct SocketBodyReader {
    stream: Option<TcpStream>,
    pool_return: Option<(Arc<HttpPool>, String)>,
    buf: Vec<u8>,
    buf_pos: usize,
    framing: BodyFraming,
    deadline: Instant,
    cancel: Option<Arc<AtomicBool>>,
}

impl SocketBodyReader {
    fn recycle_if_clean(&mut self) {
        if self.buf_pos == self.buf.len() {
            if let (Some((pool, origin)), Some(stream)) =
                (self.pool_return.take(), self.stream.take())
            {
                pool.put(origin, stream);
            }
        } else {
            self.pool_return = None;
            self.stream = None;
        }
    }

    fn fill_buf(&mut self) -> io::Result<usize> {
        if self.buf_pos < self.buf.len() {
            return Ok(self.buf.len() - self.buf_pos);
        }
        self.buf.clear();
        self.buf_pos = 0;
        let Some(stream) = self.stream.as_mut() else {
            return Ok(0);
        };
        let mut scratch = [0u8; 2048];
        loop {
            if self
                .cancel
                .as_ref()
                .is_some_and(|c| c.load(Ordering::Acquire))
            {
                self.pool_return = None;
                self.stream = None;
                return Err(io::Error::other("HTTP request cancelled"));
            }
            let now = Instant::now();
            if now >= self.deadline {
                self.pool_return = None;
                self.stream = None;
                return Err(io::Error::other("HTTP request timed out"));
            }
            let slice = (self.deadline - now)
                .min(SOCKET_SLICE)
                .max(Duration::from_millis(1));
            let _ = stream.set_read_timeout(Some(slice));
            match stream.read(&mut scratch) {
                Ok(0) => {
                    self.pool_return = None;
                    self.stream = None;
                    return Ok(0);
                }
                Ok(n) => {
                    self.buf.extend_from_slice(&scratch[..n]);
                    return Ok(n);
                }
                Err(err)
                    if matches!(
                        err.kind(),
                        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                    ) =>
                {
                    continue;
                }
                Err(err) => {
                    self.pool_return = None;
                    self.stream = None;
                    return Err(err);
                }
            }
        }
    }

    fn read_line_crlf(&mut self) -> io::Result<String> {
        let mut line = Vec::with_capacity(32);
        loop {
            if self.fill_buf()? == 0 {
                return Err(io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "unexpected EOF in chunked body",
                ));
            }
            while self.buf_pos < self.buf.len() {
                let byte = self.buf[self.buf_pos];
                self.buf_pos += 1;
                line.push(byte);
                if line.ends_with(b"\r\n") {
                    line.truncate(line.len() - 2);
                    return String::from_utf8(line).map_err(|_| {
                        io::Error::new(ErrorKind::InvalidData, "invalid chunk header")
                    });
                }
                if line.len() > 1024 {
                    return Err(io::Error::new(
                        ErrorKind::InvalidData,
                        "chunk header line too long",
                    ));
                }
            }
        }
    }

    fn consume_exact(&mut self, mut count: usize) -> io::Result<()> {
        while count > 0 {
            if self.fill_buf()? == 0 {
                return Err(io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "unexpected EOF in chunk delimiter",
                ));
            }
            let avail = (self.buf.len() - self.buf_pos).min(count);
            self.buf_pos += avail;
            count -= avail;
        }
        Ok(())
    }

    fn read_into(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self
            .cancel
            .as_ref()
            .is_some_and(|c| c.load(Ordering::Acquire))
        {
            self.pool_return = None;
            self.stream = None;
            return Err(io::Error::other("HTTP request cancelled"));
        }
        if Instant::now() >= self.deadline {
            self.pool_return = None;
            self.stream = None;
            return Err(io::Error::other("HTTP request timed out"));
        }
        match &mut self.framing {
            BodyFraming::Fixed(0) => {
                self.recycle_if_clean();
                Ok(0)
            }
            BodyFraming::Fixed(_) => {
                let available = self.fill_buf()?;
                if available == 0 {
                    return Err(io::Error::new(
                        ErrorKind::UnexpectedEof,
                        "HTTP body truncated before Content-Length",
                    ));
                }
                let BodyFraming::Fixed(remaining) = &mut self.framing else {
                    unreachable!();
                };
                let take = available.min(*remaining).min(out.len());
                out[..take].copy_from_slice(&self.buf[self.buf_pos..self.buf_pos + take]);
                self.buf_pos += take;
                *remaining -= take;
                if *remaining == 0 {
                    self.recycle_if_clean();
                }
                Ok(take)
            }
            BodyFraming::UntilEof => {
                let available = self.fill_buf()?;
                if available == 0 {
                    return Ok(0);
                }
                let take = available.min(out.len());
                out[..take].copy_from_slice(&self.buf[self.buf_pos..self.buf_pos + take]);
                self.buf_pos += take;
                Ok(take)
            }
            BodyFraming::Chunked { eof: true, .. } => Ok(0),
            BodyFraming::Chunked { .. } => {
                loop {
                    let current_rem = match &self.framing {
                        BodyFraming::Chunked {
                            chunk_remaining, ..
                        } => *chunk_remaining,
                        _ => unreachable!(),
                    };
                    if current_rem > 0 {
                        let available = self.fill_buf()?;
                        if available == 0 {
                            return Err(io::Error::new(
                                ErrorKind::UnexpectedEof,
                                "unexpected EOF in chunk payload",
                            ));
                        }
                        let take = available.min(current_rem).min(out.len());
                        out[..take]
                            .copy_from_slice(&self.buf[self.buf_pos..self.buf_pos + take]);
                        self.buf_pos += take;
                        let new_rem = current_rem - take;
                        if let BodyFraming::Chunked {
                            chunk_remaining, ..
                        } = &mut self.framing
                        {
                            *chunk_remaining = new_rem;
                        }
                        if new_rem == 0 {
                            self.consume_exact(2)?;
                        }
                        return Ok(take);
                    }
                    let size_line = self.read_line_crlf()?;
                    let hex_part = size_line.split(';').next().unwrap_or("").trim();
                    let size = usize::from_str_radix(hex_part, 16).map_err(|_| {
                        io::Error::new(ErrorKind::InvalidData, "invalid hex chunk size")
                    })?;
                    if size == 0 {
                        // Drain optional trailers up to blank line.
                        loop {
                            let trailer = self.read_line_crlf()?;
                            if trailer.is_empty() {
                                break;
                            }
                        }
                        self.framing = BodyFraming::Chunked {
                            chunk_remaining: 0,
                            eof: true,
                        };
                        self.recycle_if_clean();
                        return Ok(0);
                    }
                    self.framing = BodyFraming::Chunked {
                        chunk_remaining: size,
                        eof: false,
                    };
                }
            }
        }
    }
}
