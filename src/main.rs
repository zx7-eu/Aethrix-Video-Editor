#![windows_subsystem = "windows"]
mod agent;
mod media;
mod server;
use anyhow::{Context, Result};
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    thread,
};
use tao::{
    dpi::{LogicalSize, PhysicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    platform::windows::{IconExtWindows, WindowBuilderExtWindows},
    window::{Icon, WindowBuilder},
};
use wry::{WebContext, WebViewBuilder};

#[derive(Debug)]
enum AppEvent {
    Agent(agent::EditorCall),
    SaveVideo { id: String, name: String },
    SaveResult(serde_json::Value),
}

fn copy_export(source: &Path, destination: &Path) -> Result<()> {
    let mut file = fs::File::open(source).context("Opening the rendered video")?;
    let mut temp =
        tempfile::NamedTempFile::new_in(destination.parent().context("Invalid destination")?)?;
    std::io::copy(&mut file, temp.as_file_mut())?;
    temp.as_file().sync_all()?;
    drop(file);
    temp.persist(destination)
        .context("Saving the video to the selected location")?;
    Ok(())
}

fn install_samples(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir)?;
    macro_rules! samples { ($($name:literal),*) => {
        $(if !dir.join($name).exists(){
            let mut file=tempfile::NamedTempFile::new_in(dir)?;
            file.write_all(include_bytes!(concat!("../media/",$name)))?;
            file.persist_noclobber(dir.join($name))?;
        })*
    }}
    samples!(
        "summit.mp4",
        "summit.jpg",
        "lake.mp4",
        "lake.jpg",
        "woodland.mp4",
        "woodland.jpg",
        "night.mp4",
        "night.jpg",
        "ambience.m4a"
    );
    Ok(())
}

fn app() -> Result<()> {
    let local = PathBuf::from(
        env::var_os("LOCALAPPDATA").context("Missing local application data folder")?,
    );
    let legacy = local.join("Framecut Studio");
    let local = if legacy.join("WebView").is_dir() || legacy.join("Library").is_dir() {
        legacy
    } else {
        local.join("Aethrix")
    };
    let exe = env::current_exe()?;
    let beside = exe.parent().context("Missing application directory")?;
    let mut root = if beside.join("media").is_dir() {
        beside.to_owned()
    } else {
        local.join("Library")
    };
    let mut profile = local.join("WebView");
    let mut port = 28741;
    let mut headless = false;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => port = args.next().context("Missing port")?.parse()?,
            "--data-dir" => root = args.next().context("Missing data directory")?.into(),
            "--profile" => profile = args.next().context("Missing profile directory")?.into(),
            "--headless" => headless = true,
            _ => anyhow::bail!("Unknown option {arg}"),
        }
    }
    install_samples(&root.join("media"))?;
    let url = server::start(root.clone(), port)?;
    if headless {
        loop {
            thread::park();
        }
    }
    fs::create_dir_all(&profile)?;
    let event_loop = EventLoopBuilder::<AppEvent>::with_user_event().build();
    let replies = agent::Replies::default();
    let exports = root.join("exports");
    let save_events = event_loop.create_proxy();
    let ipc_events = save_events.clone();
    agent::start(root, port, event_loop.create_proxy(), replies.clone())?;
    let window = WindowBuilder::new()
        .with_title("Aethrix")
        .with_window_icon(Some(Icon::from_resource(
            1,
            Some(PhysicalSize::new(32, 32)),
        )?))
        .with_taskbar_icon(Some(Icon::from_resource(
            1,
            Some(PhysicalSize::new(64, 64)),
        )?))
        .with_inner_size(LogicalSize::new(1380, 850))
        .with_min_inner_size(LogicalSize::new(760, 560))
        .build(&event_loop)?;
    let mut context = WebContext::new(Some(profile));
    let home = url.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_url(&url)
        .with_ipc_handler(move |msg| {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(msg.body())
                && data["action"] == "saveVideo"
                && let (Some(id), Some(name)) = (data["export"].as_str(), data["name"].as_str())
                && id.len() == 32
                && id.bytes().all(|b| b.is_ascii_hexdigit())
            {
                let _ = ipc_events.send_event(AppEvent::SaveVideo {
                    id: id.to_owned(),
                    name: name.to_owned(),
                });
            } else {
                agent::reply(&replies, msg.body());
            }
        })
        .with_navigation_handler(move |u| {
            u == home
                || u.starts_with(&format!("blob:{home}"))
                || u.starts_with(&format!("{home}exports/"))
        })
        .build(&window)?;
    event_loop.run(move |event, _, flow| {
        let _keep_alive = &webview;
        *flow = ControlFlow::Wait;
        if let Event::UserEvent(AppEvent::Agent(ref call)) = event {
            let message = serde_json::to_string(call).expect("serializable editor call");
            let _ = webview.evaluate_script(&format!("window.aethrixAgent({message})"));
        }
        if let Event::UserEvent(AppEvent::SaveVideo { ref id, ref name }) = event {
            let picker = rfd::FileDialog::new()
                .set_parent(&window)
                .set_title("Save video")
                .add_filter("MP4 video", &["mp4"])
                .set_file_name(name);
            let destination = picker.save_file();
            let id = id.clone();
            let source = exports.join(format!("{id}.mp4"));
            let events = save_events.clone();
            thread::spawn(move || {
                let result = match destination {
                    None => serde_json::json!({"id":id,"cancelled":true}),
                    Some(path) => match copy_export(&source, &path) {
                        Ok(()) => serde_json::json!({"id":id,"path":path}),
                        Err(e) => serde_json::json!({"id":id,"error":format!("{e:#}")}),
                    },
                };
                let _ = events.send_event(AppEvent::SaveResult(result));
            });
        }
        if let Event::UserEvent(AppEvent::SaveResult(ref result)) = event {
            let _ = webview.evaluate_script(&format!(
                "window.dispatchEvent(new CustomEvent('video-saved',{{detail:{result}}}))"
            ));
        }
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            *flow = ControlFlow::Exit;
        }
    })
}

#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(hwnd: isize, text: *const u16, title: *const u16, kind: u32) -> i32;
}
fn main() {
    if env::args().nth(1).as_deref() == Some("--mcp") {
        let result = (|| -> Result<()> {
            let port = match env::args().nth(2) {
                None => 28741,
                Some(flag) if flag == "--port" => {
                    env::args().nth(3).context("Missing port")?.parse()?
                }
                _ => anyhow::bail!("Use --mcp [--port PORT]"),
            };
            agent::stdio(port)
        })();
        if let Err(e) = result {
            eprintln!("{e:#}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(e) = app() {
        let text: Vec<_> = format!("{e:#}").encode_utf16().chain(Some(0)).collect();
        let title: Vec<_> = "Aethrix".encode_utf16().chain(Some(0)).collect();
        unsafe {
            MessageBoxW(0, text.as_ptr(), title.as_ptr(), 0x10);
        }
        std::process::exit(1);
    }
}
