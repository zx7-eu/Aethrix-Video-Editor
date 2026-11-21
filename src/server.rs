use crate::media;
use anyhow::{Context, Result, ensure};
use include_dir::{Dir, include_dir};
use percent_encoding::percent_decode_str;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};
use tiny_http::{Header, Request, Response, Server};

static UI: Dir = include_dir!("$CARGO_MANIFEST_DIR/ui");
type Jobs = Arc<Mutex<HashMap<String, Value>>>;
fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).expect("valid response header")
}
fn value<'a>(r: &'a Request, name: &'static str) -> Option<&'a str> {
    r.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}
fn json_response(r: Request, data: Value, status: u16) {
    let _ = r.respond(
        Response::from_string(data.to_string())
            .with_status_code(status)
            .with_header(header("Content-Type", "application/json")),
    );
}
fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css",
        Some("js") => "text/javascript",
        Some("json") => "application/json",
        Some("md") => "text/plain; charset=utf-8",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("mp4") => "video/mp4",
        Some("m4a") => "audio/mp4",
        Some("jpg") => "image/jpeg",
        _ => "application/octet-stream",
    }
}

fn serve_file(r: Request, path: &Path, name: &str) -> Result<()> {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return Ok(r.respond(Response::empty(404))?),
    };
    let size = file.metadata()?.len();
    let range = value(&r, "Range")
        .and_then(|s| s.strip_prefix("bytes="))
        .and_then(|s| s.split_once('-'));
    let (start, end) = match range {
        Some(("", suffix)) => (size.saturating_sub(suffix.parse()?), size.saturating_sub(1)),
        Some((s, e)) => (
            s.parse()?,
            if e.is_empty() {
                size.saturating_sub(1)
            } else {
                e.parse::<u64>()?.min(size.saturating_sub(1))
            },
        ),
        None => (0, size.saturating_sub(1)),
    };
    if size == 0 || start > end || start >= size {
        return Ok(r.respond(
            Response::empty(416).with_header(header("Content-Range", &format!("bytes */{size}"))),
        )?);
    }
    file.seek(SeekFrom::Start(start))?;
    let len = end - start + 1;
    let mut headers = vec![
        header("Content-Type", mime(name)),
        header("Accept-Ranges", "bytes"),
    ];
    if range.is_some() {
        headers.push(header(
            "Content-Range",
            &format!("bytes {start}-{end}/{size}"),
        ));
    }
    let partial = range.is_some();
    r.respond(Response::new(
        if partial { 206.into() } else { 200.into() },
        headers,
        file.take(len),
        Some(len as usize),
        None,
    ))?;
    Ok(())
}
fn upload(r: &mut Request, media: &Path) -> Result<Value> {
    let encoded = value(r, "X-Filename").unwrap_or("clip");
    let name = percent_decode_str(encoded)
        .decode_utf8()?
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("clip")
        .to_owned();
    let tmp = tempfile::tempdir()?;
    let input = tmp.path().join("source");
    io::copy(r.as_reader(), &mut File::create(&input)?)?;
    media::import(&input, &name, media)
}
fn export(r: &mut Request, jobs: Jobs, root: Arc<PathBuf>) -> Result<Value> {
    let mut bytes = Vec::new();
    r.as_reader().take(64_000_001).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 64_000_000,
        "Title overlays exceed export size limit"
    );
    let project = serde_json::from_slice(&bytes)?;
    let uid = media::id();
    jobs.lock()
        .unwrap()
        .insert(uid.clone(), json!({"progress":0}));
    let key = uid.clone();
    thread::spawn(move || {
        let result = media::render(
            &project,
            &root.join("media"),
            &root.join("exports").join(format!("{key}.mp4")),
            |n| {
                jobs.lock()
                    .unwrap()
                    .insert(key.clone(), json!({"progress":n}));
            },
        );
        let result = match result {
            Ok(()) => json!({"progress":100,"url":format!("/exports/{key}.mp4")}),
            Err(e) => json!({"error":format!("{e:#}")}),
        };
        jobs.lock().unwrap().insert(key, result);
    });
    Ok(json!({"id":uid}))
}

fn handle(mut r: Request, root: Arc<PathBuf>, jobs: Jobs, authority: &str) -> Result<()> {
    let path = r.url().split('?').next().unwrap_or("/").to_owned();
    if value(&r, "Host") != Some(authority) {
        return Ok(r.respond(Response::empty(403))?);
    }
    if r.method().as_str() == "POST" {
        if value(&r, "Origin").is_some_and(|o| o != format!("http://{authority}"))
            || value(&r, "Sec-Fetch-Site") == Some("cross-site")
        {
            return Ok(r.respond(Response::empty(403))?);
        }
        let result = match path.as_str() {
            "/import" => upload(&mut r, &root.join("media")),
            "/export" => export(&mut r, jobs, root),
            _ => return Ok(r.respond(Response::empty(404))?),
        };
        match result {
            Ok(data) => json_response(r, data, 200),
            Err(e) => json_response(r, json!({"error":format!("{e:#}")}), 400),
        }
        return Ok(());
    }
    if r.method().as_str() != "GET" {
        return Ok(r.respond(Response::empty(405))?);
    }
    if let Some(id) = path.strip_prefix("/jobs/") {
        json_response(
            r,
            jobs.lock()
                .unwrap()
                .get(id)
                .cloned()
                .unwrap_or_else(|| json!({"error":"Unknown export"})),
            200,
        );
    } else if path == "/" || path.starts_with("/ui/") {
        let name = path.strip_prefix("/ui/").unwrap_or("index.html");
        if let Some(file) = UI.get_file(name) {
            r.respond(
                Response::from_data(file.contents())
                    .with_header(header("Content-Type", mime(name))),
            )?;
        } else {
            r.respond(Response::empty(404))?;
        }
    } else if let Some((dir, name)) = path.trim_start_matches('/').split_once('/')
        && ["exports", "media"].contains(&dir)
        && media::safe_name(name)
    {
        serve_file(r, &root.join(dir).join(name), name)?;
    } else {
        r.respond(Response::empty(404))?;
    }
    Ok(())
}

pub fn start(root: PathBuf, port: u16) -> Result<String> {
    fs::create_dir_all(root.join("exports"))?;
    let server = Server::http(("127.0.0.1", port))
        .map_err(|e| anyhow::anyhow!("Cannot open editor port {port}: {e}"))?;
    let authority = server
        .server_addr()
        .to_ip()
        .context("Expected local IP")?
        .to_string();
    let url = format!("http://{authority}/");
    let jobs = Jobs::default();
    let root = Arc::new(root);
    thread::spawn(move || {
        for request in server.incoming_requests() {
            let (root, jobs, authority) = (root.clone(), jobs.clone(), authority.clone());
            thread::spawn(move || {
                let _ = handle(request, root, jobs, &authority);
            });
        }
    });
    Ok(url)
}
