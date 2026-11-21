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
    let event_loop = EventLoopBuilder::<agent::EditorCall>::with_user_event().build();
    let replies = agent::Replies::default();
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
        .with_ipc_handler(move |msg| agent::reply(&replies, msg.body()))
        .with_navigation_handler(move |u| {
            u == home
                || u.starts_with(&format!("blob:{home}"))
                || u.starts_with(&format!("{home}exports/"))
        })
        .build(&window)?;
    event_loop.run(move |event, _, flow| {
        let _keep_alive = &webview;
        *flow = ControlFlow::Wait;
        if let Event::UserEvent(ref call) = event {
            let message = serde_json::to_string(call).expect("serializable editor call");
            let _ = webview.evaluate_script(&format!("window.aethrixAgent({message})"));
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
