use crate::media;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};
use tao::event_loop::EventLoopProxy;

pub type Replies = Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>;
#[derive(Debug, Serialize)]
pub struct EditorCall {
    id: String,
    tool: String,
    args: Value,
}
#[derive(Serialize, Deserialize)]
struct Address {
    port: u16,
    token: String,
}
#[derive(Deserialize)]
struct Request {
    token: String,
    tool: String,
    args: Value,
}
fn address_file(port: u16) -> Result<PathBuf> {
    Ok(
        PathBuf::from(env::var_os("LOCALAPPDATA").context("Missing user directory")?)
            .join("Aethrix")
            .join(format!("session-{port}.json")),
    )
}
fn read_line(stream: &TcpStream, limit: u64) -> Result<Value> {
    let mut line = String::new();
    BufReader::new(stream.take(limit + 1)).read_line(&mut line)?;
    ensure!(
        line.len() <= limit as usize && line.ends_with('\n'),
        "Incomplete or oversized editor message"
    );
    Ok(serde_json::from_str(&line)?)
}
fn write_line(mut stream: &TcpStream, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut stream, value)?;
    stream.write_all(b"\n")?;
    Ok(())
}
pub fn start(
    root: PathBuf,
    port: u16,
    proxy: EventLoopProxy<EditorCall>,
    replies: Replies,
) -> Result<()> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let address = Address {
        port: listener.local_addr()?.port(),
        token: media::id(),
    };
    let file = address_file(port)?;
    let parent = file.parent().context("Invalid session directory")?;
    fs::create_dir_all(parent)?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(tmp.as_file_mut(), &address)?;
    tmp.persist(&file)?;
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (proxy, replies, token, root) = (
                proxy.clone(),
                replies.clone(),
                address.token.clone(),
                root.clone(),
            );
            thread::spawn(move || {
                let result = (|| -> Result<Value> {
                    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
                    let req: Request = serde_json::from_value(read_line(&stream, 4_000_000)?)?;
                    ensure!(req.token == token, "Invalid editor session");
                    let mut args = req.args;
                    if req.tool == "import_media" {
                        let path = Path::new(
                            args["path"]
                                .as_str()
                                .context("Provide an absolute media path")?,
                        );
                        ensure!(
                            path.is_absolute() && path.is_file(),
                            "Media file does not exist"
                        );
                        let name = path
                            .file_name()
                            .and_then(|x| x.to_str())
                            .context("Invalid filename")?;
                        args = json!({"asset":media::import(path,name,&root.join("media"))?});
                    }
                    let id = media::id();
                    let (tx, rx) = mpsc::channel();
                    replies.lock().unwrap().insert(id.clone(), tx);
                    let sent = proxy
                        .send_event(EditorCall {
                            id: id.clone(),
                            tool: req.tool.clone(),
                            args,
                        })
                        .is_ok();
                    let response = if sent {
                        rx.recv_timeout(Duration::from_secs(25)).ok()
                    } else {
                        None
                    };
                    replies.lock().unwrap().remove(&id);
                    let mut response = response.context(
                        "Editor stopped responding. Inspect the timeline before retrying an edit.",
                    )?;
                    if req.tool == "export_status"
                        && let Some(url) = response["value"]["url"].as_str()
                        && let Some(name) = url
                            .strip_prefix("/exports/")
                            .filter(|n| media::safe_name(n))
                    {
                        response["value"]["path"] = json!(root.join("exports").join(name));
                    }
                    Ok(response)
                })();
                let _ = write_line(
                    &stream,
                    &result.unwrap_or_else(|e| json!({"error":format!("{e:#}")})),
                );
            });
        }
    });
    Ok(())
}
pub fn reply(replies: &Replies, body: &str) {
    if let Ok(msg) = serde_json::from_str::<Value>(body)
        && let Some(id) = msg["id"].as_str()
        && let Some(tx) = replies.lock().unwrap().remove(id)
    {
        let _ = tx.send(msg);
    }
}

fn call(port: u16, tool: &str, args: &Value) -> Result<Value> {
    let info: Address = serde_json::from_slice(
        &fs::read(address_file(port)?)
            .context("Open Aethrix.exe to connect to its live timeline")?,
    )?;
    let stream = TcpStream::connect((Ipv4Addr::LOCALHOST, info.port))
        .context("Open Aethrix.exe to start an editing session")?;
    write_line(
        &stream,
        &json!({"token":info.token,"tool":tool,"args":args}),
    )?;
    let response = read_line(&stream, 32_000_000)?;
    if let Some(e) = response["error"].as_str() {
        anyhow::bail!("{e}");
    }
    let val = &response["value"];
    if tool == "preview_frame" {
        return Ok(
            json!({"content":[{"type":"image","mimeType":"image/jpeg","data":val["image"]},{"type":"text","text":format!("Timeline frame at {} seconds",val["time"])}]}),
        );
    }
    Ok(
        json!({"content":[{"type":"text","text":serde_json::to_string(val)?}],"structuredContent":val}),
    )
}
pub fn stdio(port: u16) -> Result<()> {
    let tools: Value = serde_json::from_str(include_str!("tools.json"))?;
    let mut phase = 0;
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        let parsed = serde_json::from_str::<Value>(&line);
        let req = parsed.as_ref().ok();
        let id = req
            .and_then(|r| r.get("id"))
            .cloned()
            .unwrap_or(Value::Null);
        let error = |code: i32, msg: &str| json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":msg}});
        let result = match parsed {
            Err(_) => error(-32700, "Parse error"),
            Ok(r) if r["jsonrpc"] != "2.0" || !r["method"].is_string() => {
                error(-32600, "Invalid request")
            }
            Ok(r) => {
                let method = r["method"].as_str().unwrap();
                if r.get("id").is_none() {
                    if method == "notifications/initialized" && phase == 1 {
                        phase = 2;
                    }
                    continue;
                }
                let result = match method {
                    "initialize" if phase == 0 => {
                        phase = 1;
                        let ver = match r["params"]["protocolVersion"].as_str() {
                            Some(v @ ("2024-11-05" | "2025-03-26" | "2025-06-18")) => v,
                            _ => "2025-11-25",
                        };
                        Some(
                            json!({"protocolVersion":ver,"capabilities":{"tools":{}},"serverInfo":{"name":"aethrix","version":env!("CARGO_PKG_VERSION")},"instructions":"Open Aethrix.exe. Call inspect_project for the current revision and IDs. Submit timeline changes together using edit_timeline. Use preview_frame to review the actual composited picture."}),
                        )
                    }
                    "ping" => Some(json!({})),
                    "tools/list" if phase == 2 => Some(json!({"tools":tools})),
                    "tools/call" if phase == 2 => {
                        let name = r["params"]["name"].as_str().unwrap_or("");
                        if tools.as_array().unwrap().iter().any(|t| t["name"] == name) {
                            Some(call(port,name,&r["params"]["arguments"]).unwrap_or_else(|e|json!({"isError":true,"content":[{"type":"text","text":format!("{e:#}")}]})))
                        } else {
                            None
                        }
                    }
                    _ => None,
                };
                if let Some(v) = result {
                    json!({"jsonrpc":"2.0","id":id,"result":v})
                } else if method == "tools/call" && phase == 2 {
                    error(-32602, "Unknown tool")
                } else if phase != 2 {
                    error(-32002, "Initialize the server first")
                } else {
                    error(-32601, "Method not found")
                }
            }
        };
        serde_json::to_writer(&mut out, &result)?;
        out.write_all(b"\n")?;
        out.flush()?;
    }
    Ok(())
}
