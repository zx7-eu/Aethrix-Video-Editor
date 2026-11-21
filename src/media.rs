use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::os::windows::process::CommandExt;
use std::{
    collections::HashMap,
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use uuid::Uuid;

pub fn id() -> String {
    Uuid::new_v4().simple().to_string()
}

fn command(tool: &str) -> Command {
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|p| Some(p.parent()?.join("bin").join(format!("{tool}.exe"))));
    let mut cmd = Command::new(
        sibling
            .filter(|p| p.is_file())
            .unwrap_or_else(|| tool.into()),
    );
    cmd.creation_flags(0x08000000);
    cmd
}

fn output(cmd: &mut Command) -> Result<Vec<u8>> {
    let result = cmd.output().with_context(|| {
        format!(
            "Could not run {}. Install FFmpeg or add its tools to the bin folder.",
            cmd.get_program().to_string_lossy()
        )
    })?;
    if !result.status.success() {
        let msg = String::from_utf8_lossy(&result.stderr);
        bail!(
            "{}",
            msg.chars()
                .rev()
                .take(1800)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
                .trim()
        );
    }
    Ok(result.stdout)
}

fn ff() -> Command {
    let mut c = command("ffmpeg");
    c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    c
}
fn probe(path: &Path) -> Result<Value> {
    let bytes = output(
        command("ffprobe")
            .args([
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
            ])
            .arg(path),
    )?;
    Ok(serde_json::from_slice(&bytes)?)
}
pub fn safe_name(name: &str) -> bool {
    !name.starts_with('.')
        && !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

pub fn import(input: &Path, name: &str, media: &Path) -> Result<Value> {
    let info = probe(input)?;
    let streams = info["streams"].as_array().context("Missing streams")?;
    let video = streams.iter().find(|s| {
        s["codec_type"] == "video" && s["disposition"]["attached_pic"].as_i64() != Some(1)
    });
    let extension = Path::new(name)
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let still = video.is_some()
        && ["png", "webp", "jpg", "jpeg", "avif", "bmp"].contains(&extension.as_str());
    let (kind, ext) = if still {
        ("image", "jpg")
    } else if video.is_some() {
        ("video", "mp4")
    } else {
        ("audio", "m4a")
    };
    let uid = id();
    let file = format!("{uid}.{ext}");
    let thumb = format!("{uid}-thumb.jpg");
    let staging = tempfile::tempdir_in(media)?;
    let converted = staging.path().join(&file);
    let mut cmd = ff();
    cmd.arg("-i").arg(input);
    if still {
        cmd.args(["-frames:v", "1", "-vf", "scale='min(2560,iw)':-2"]);
    } else if let Some(stream) = video {
        cmd.args([
            "-map",
            &format!("0:{}", stream["index"]),
            "-map",
            "0:a:0?",
            "-vf",
            "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
        ]);
    } else {
        cmd.args(["-vn", "-c:a", "aac"]);
    }
    output(cmd.arg(&converted))?;
    let duration = if still {
        6.0
    } else {
        probe(&converted)?["format"]["duration"]
            .as_str()
            .context("Missing duration")?
            .parse::<f64>()?
    };
    if video.is_some() {
        output(
            ff().arg("-i")
                .arg(&converted)
                .args(["-frames:v", "1", "-vf", "scale=400:-2"])
                .arg(staging.path().join(&thumb)),
        )?;
        fs::rename(staging.path().join(&thumb), media.join(&thumb))?;
    }
    fs::rename(converted, media.join(&file))?;
    Ok(
        json!({"id":uid,"name":name,"kind":kind,"url":format!("/media/{file}"),"thumb":if video.is_some(){format!("/media/{thumb}")}else{String::new()},"duration":duration}),
    )
}

#[derive(Deserialize)]
pub struct Export {
    project: Project,
    size: u32,
    titles: Vec<String>,
}
#[derive(Deserialize)]
struct Project {
    ratio: String,
    assets: Vec<Asset>,
    clips: Vec<Clip>,
    music: Option<Music>,
}
#[derive(Deserialize)]
struct Asset {
    id: String,
    url: String,
    kind: String,
}
#[derive(Deserialize)]
struct Clip {
    #[serde(default)]
    motion: String,
    #[serde(default, rename = "fadeIn")]
    fade_in: f64,
    #[serde(default, rename = "fadeOut")]
    fade_out: f64,
    asset: String,
    start: f64,
    end: f64,
    speed: f64,
    zoom: f64,
    brightness: f64,
    saturation: f64,
    contrast: f64,
    volume: f64,
}
#[derive(Deserialize)]
struct Music {
    asset: String,
    volume: f64,
    #[serde(default)]
    start: f64,
    #[serde(default)]
    offset: f64,
}
fn checked(v: f64, min: f64, max: f64) -> Result<f64> {
    ensure!((min..=max).contains(&v), "Invalid editing value {v}");
    Ok(v)
}

pub fn render(job: &Export, media: &Path, target: &Path, progress: impl Fn(u32)) -> Result<()> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Motion {
        start: f64,
        end: f64,
        frames: u32,
        anchor_x: f64,
        anchor_y: f64,
    }
    let presets: HashMap<String, Motion> = serde_json::from_str(include_str!("../ui/motion.json"))?;
    let p = &job.project;
    ensure!(
        !p.clips.is_empty() && job.titles.len() == p.clips.len(),
        "Invalid timeline"
    );
    ensure!(
        [720, 1080, 2160].contains(&job.size),
        "Unsupported resolution"
    );
    let size = job.size;
    let wide = ((size as f64 * 16.0 / 9.0 / 2.0).round() as u32) * 2;
    let (w, h) = match p.ratio.as_str() {
        "16:9" => (wide, size),
        "9:16" => (size, wide),
        "1:1" => (size, size),
        _ => bail!("Unknown aspect ratio"),
    };
    let assets: HashMap<_, _> = p.assets.iter().map(|a| (a.id.as_str(), a)).collect();
    let source = |key: &str| -> Result<(&Asset, PathBuf)> {
        let a = *assets.get(key).context("Missing asset")?;
        let name = a
            .url
            .strip_prefix("/media/")
            .filter(|s| safe_name(s))
            .context("Invalid media filename")?;
        let path = media.join(name);
        ensure!(path.is_file(), "Missing media file {name}");
        Ok((a, path))
    };
    let tmp = tempfile::tempdir()?;
    let mut manifest = String::new();
    for (i, c) in p.clips.iter().enumerate() {
        let (a, path) = source(&c.asset)?;
        let start = checked(c.start, 0., 1e7)?;
        let speed = checked(c.speed, 0.5, 2.)?;
        let length = checked(c.end - start, 0.04, 1e7)? / speed;
        let zoom = checked(c.zoom, 1., 2.)?;
        let (zw, zh) = (
            (w as f64 * zoom) as u32 / 2 * 2,
            (h as f64 * zoom) as u32 / 2 * 2,
        );
        let bright = checked(c.brightness, 0.5, 1.5)?;
        let contrast = checked(c.contrast, 0.5, 1.5)?;
        let sat = checked(c.saturation, 0., 2.)?;
        let vol = checked(c.volume, 0., 2.)?;
        let mut cmd = ff();
        if a.kind == "image" {
            cmd.args(["-loop", "1", "-framerate", "24"]);
        } else {
            cmd.arg("-ss").arg(start.to_string());
        }
        cmd.arg("-i")
            .arg(&path)
            .args(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]);
        let has_audio = probe(&path)?["streams"]
            .as_array()
            .context("Missing streams")?
            .iter()
            .any(|s| s["codec_type"] == "audio");
        let lut = ["r", "g", "b"]
            .map(|ch| format!("{ch}='(val*{bright}-127.5)*{contrast}+127.5'"))
            .join(":");
        let motion = if c.motion.is_empty() {
            String::new()
        } else {
            let m = presets
                .get(&c.motion)
                .context("Unknown camera motion preset")?;
            let u = format!("min(1,on/{})", m.frames);
            let ease = format!("(1-(1+7*{u})*exp(-7*{u}))/(1-8*exp(-7))");
            format!(
                "zoompan=z='{}*pow({}/{},{ease})':x='(iw-iw/zoom)*{}':y='(ih-ih/zoom)*{}':d=1:s={w}x{h}:fps=24,",
                m.start, m.end, m.start, m.anchor_x, m.anchor_y
            )
        };
        let mut graph = format!(
            "[0:v]setpts=(PTS-STARTPTS)/{speed},fps=24,scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},scale={zw}:{zh},crop={w}:{h},{motion}setsar=1,eq=saturation={sat},format=gbrp,lutrgb={lut},format=yuv420p,tpad=stop_mode=clone:stop_duration=1[v]"
        );
        let mut vtag = "[v]";
        if !job.titles[i].is_empty() {
            let title = tmp.path().join("title.png");
            fs::write(&title, STANDARD.decode(&job.titles[i])?)?;
            cmd.arg("-i").arg(title);
            graph.push_str(";[v][2:v]overlay=0:0[out]");
            vtag = "[out]";
        }
        let audio = if has_audio { "0:a:0" } else { "1:a" };
        let fade_in = checked(c.fade_in, 0., 60.)?.min(length);
        let fade_out = checked(c.fade_out, 0., 60.)?.min(length);
        let mut video_fades = Vec::new();
        let mut audio_fades = String::new();
        for (direction, start, duration) in
            [("in", 0., fade_in), ("out", length - fade_out, fade_out)]
        {
            if duration > 0. {
                let timing = format!("t={direction}:st={start}:d={duration}");
                video_fades.push(format!("fade={timing}"));
                audio_fades.push_str(&format!(",afade={timing}"));
            }
        }
        if !video_fades.is_empty() {
            graph.push_str(&format!(";{vtag}{}[faded]", video_fades.join(",")));
            vtag = "[faded]";
        }
        graph.push_str(&format!(";[{audio}]asetpts=PTS-STARTPTS,atempo={speed},volume={vol},aresample=48000,aformat=channel_layouts=stereo,apad{audio_fades}[a]"));
        let part = format!("clip{i}.mp4");
        output(
            cmd.args([
                "-filter_complex",
                &graph,
                "-map",
                vtag,
                "-map",
                "[a]",
                "-t",
                &length.to_string(),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "19",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
            ])
            .arg(tmp.path().join(&part)),
        )?;
        manifest.push_str(&format!("file '{part}'\n"));
        progress((90 * (i + 1) / p.clips.len()) as u32);
    }
    let list = tmp.path().join("clips.txt");
    fs::write(&list, manifest)?;
    let mut cmd = ff();
    cmd.args(["-f", "concat", "-safe", "0", "-i"]).arg(list);
    if let Some(m) = &p.music {
        let (_, music) = source(&m.asset)?;
        let volume = checked(m.volume, 0., 1.)?;
        let delay = (checked(m.start, 0., 1e7)? * 1000.).round();
        let graph = format!(
            "[1:a]volume={volume},adelay={delay}:all=1[m];[0:a][m]amix=duration=first:normalize=0[a]"
        );
        cmd.arg("-ss")
            .arg(checked(m.offset, 0., 1e7)?.to_string())
            .arg("-i")
            .arg(music)
            .args([
                "-filter_complex",
                &graph,
                "-map",
                "0:v",
                "-map",
                "[a]",
                "-c:a",
                "aac",
                "-c:v",
                "copy",
            ]);
    } else {
        cmd.args(["-c", "copy"]);
    }
    let staging = tempfile::tempdir_in(target.parent().context("Invalid export path")?)?;
    let finished = staging.path().join("finished.mp4");
    output(cmd.args(["-movflags", "+faststart"]).arg(&finished))?;
    fs::rename(finished, target)?;
    Ok(())
}
