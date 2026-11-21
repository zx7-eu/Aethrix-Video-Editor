"""Aethrix local editing server. Launch with python editor.py."""
import argparse
import base64
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, unquote

ROOT = Path(__file__).resolve().parent
MEDIA = ROOT / "media"
EXPORTS = ROOT / "exports"
JOBS = {}
SIZES = {"16:9": (16, 9), "9:16": (9, 16), "1:1": (1, 1)}


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, encoding="utf8", errors="replace")
    if result.returncode:
        raise ValueError(result.stderr.strip()[-1600:] or "Media processing failed.")
    return result.stdout


def ff(*args):
    return run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)])


def probe(path):
    return json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]))


def media_path(value):
    if not re.fullmatch(r"/media/[\w.-]+", value):
        raise ValueError("Invalid media reference.")
    path = MEDIA / value.split("/")[-1]
    if not path.is_file():
        raise ValueError("Project media is missing.")
    return path


def num(value, low, high):
    val = float(value)
    if not math.isfinite(val) or not low <= val <= high:
        raise ValueError("An editing value is outside its supported range.")
    return val


def import_asset(path, original):
    info = probe(path)
    streams = info["streams"]
    picture = next((s for s in streams if s["codec_type"] == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    still = picture and path.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".avif")
    kind = ("image" if still else "video") if picture else "audio"
    uid = uuid.uuid4().hex
    suffix = {"image": ".jpg", "video": ".mp4", "audio": ".m4a"}[kind]
    dest = MEDIA / (uid + suffix)
    thumb = MEDIA / (uid + "-thumb.jpg")
    try:
        if still:
            ff("-i", path, "-frames:v", 1, "-vf", "scale='min(2560,iw)':-2", dest)
        elif picture:
            ff("-i", path, "-map", "0:" + str(picture["index"]), "-map", "0:a:0?", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", 18, "-c:a", "aac", "-movflags", "+faststart", dest)
        else:
            ff("-i", path, "-vn", "-c:a", "aac", dest)
        if picture:
            ff("-i", dest, "-frames:v", 1, "-vf", "scale=400:-2", thumb)
        duration = 6 if still else float(probe(dest)["format"]["duration"])
        return dict(id=uid, name=original, kind=kind, url="/media/"+dest.name, thumb="/media/"+thumb.name if picture else "", duration=duration)
    except Exception:
        dest.unlink(missing_ok=True)
        thumb.unlink(missing_ok=True)
        raise


def render(job_id, data):
    job = JOBS[job_id]
    try:
        p = data["project"]
        assets = {a["id"]: a for a in p["assets"]}
        clips = p["clips"]
        if not clips:
            raise ValueError("Add a visual clip before exporting.")
        a, b = SIZES[p["ratio"]]
        size = int(num(data["size"], 360, 2160))
        w, h = (round(size*a/b/2)*2, size) if a >= b else (size, round(size*b/a/2)*2)
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            parts = []
            for i, c in enumerate(clips):
                asset = assets[c["asset"]]
                source = media_path(asset["url"])
                start = num(c["start"], 0, 1e7)
                speed = num(c["speed"], 0.5, 2)
                length = num(float(c["end"])-start, 0.04, 1e7)/speed
                inp = ["-loop", "1", "-framerate", "24"] if asset["kind"] == "image" else ["-ss", str(start)]
                has_audio = any(s["codec_type"] == "audio" for s in probe(source)["streams"])
                zoom = num(c["zoom"], 1, 2)
                bright = num(c["brightness"], .5, 1.5)
                sat = num(c["saturation"], 0, 2)
                contrast = num(c["contrast"], .5, 1.5)
                motion = ""
                if c.get("motion"):
                    preset = json.loads((ROOT / "ui" / "motion.json").read_text())[c["motion"]]
                    u = f"min(1,on/{preset['frames']})"
                    ease = f"(1-(1+7*{u})*exp(-7*{u}))/(1-8*exp(-7))"
                    motion = f"zoompan=z='{preset['start']}*pow({preset['end']}/{preset['start']},{ease})':x='(iw-iw/zoom)*{preset['anchorX']}':y='(ih-ih/zoom)*{preset['anchorY']}':d=1:s={w}x{h}:fps=24,"
                vf = f"[0:v]setpts=(PTS-STARTPTS)/{speed},fps=24,scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},scale={int(w*zoom)//2*2}:{int(h*zoom)//2*2},crop={w}:{h},{motion}setsar=1,eq=saturation={sat},format=gbrp,lutrgb=" + ":".join(f"{ch}='(val*{bright}-127.5)*{contrast}+127.5'" for ch in "rgb") + ",format=yuv420p,tpad=stop_mode=clone:stop_duration=1[v]"
                inputs = [*inp, "-i", source, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
                vtag = "[v]"
                if data["titles"][i]:
                    overlay = work / "title.png"
                    overlay.write_bytes(base64.b64decode(data["titles"][i], validate=True))
                    inputs += ["-i", overlay]
                    vf += ";[v][2:v]overlay=0:0[out]"
                    vtag = "[out]"
                af = f"[{'0:a:0' if has_audio else '1:a'}]asetpts=PTS-STARTPTS,atempo={speed},volume={num(c['volume'],0,2)},aresample=48000,aformat=channel_layouts=stereo,apad[a]"
                part = work / f"clip{i}.mp4"
                ff(*inputs, "-filter_complex", vf+";"+af, "-map", vtag, "-map", "[a]", "-t", length, "-c:v", "libx264", "-preset", "veryfast", "-crf", 19, "-pix_fmt", "yuv420p", "-c:a", "aac", part)
                parts.append(part)
                job["progress"] = round(90*(i+1)/len(clips))
            manifest = work / "clips.txt"
            manifest.write_text("\n".join("file '"+x.name+"'" for x in parts))
            EXPORTS.mkdir(exist_ok=True)
            target = EXPORTS / (job_id+".mp4")
            args = ["-f", "concat", "-safe", 0, "-i", manifest]
            if p.get("music"):
                m = p["music"]
                args += ["-ss", num(m.get("offset",0),0,1e7), "-i", media_path(assets[m["asset"]]["url"]), "-filter_complex", f"[1:a]volume={num(m['volume'],0,1)},adelay={round(num(m.get('start',0),0,1e7)*1000)}:all=1[m];[0:a][m]amix=duration=first:normalize=0[a]", "-map","0:v","-map","[a]","-c:a","aac","-c:v","copy"]
            else:
                args += ["-c","copy"]
            ff(*args, "-movflags", "+faststart", target)
            job.update(progress=100, url="/exports/"+target.name)
    except Exception as exc:
        job["error"] = str(exc)


class Handler(BaseHTTPRequestHandler):
    def json(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        origin = self.headers.get("Origin")
        if self.headers.get("Host") != self.server.authority or (origin and origin != "http://"+self.server.authority):
            return self.send_error(403)
        try:
            length = int(self.headers.get("Content-Length", 0))
            if self.path == "/import":
                name = Path(unquote(self.headers.get("X-Filename","clip"))).name
                with tempfile.TemporaryDirectory() as tmp:
                    path = Path(tmp) / ("input"+Path(name).suffix)
                    with path.open("wb") as f:
                        while length:
                            chunk = self.rfile.read(min(length, 1024*1024))
                            if not chunk:
                                raise ValueError("Upload interrupted.")
                            length -= len(chunk)
                            f.write(chunk)
                    asset = import_asset(path, name)
                return self.json(asset)
            if self.path == "/export" and 0 < length < 64000000:
                data = json.loads(self.rfile.read(length))
                uid = uuid.uuid4().hex
                JOBS[uid] = {"progress":0}
                threading.Thread(target=render,args=(uid,data),daemon=True).start()
                return self.json({"id":uid})
            self.send_error(404)
        except Exception as exc:
            self.json({"error":str(exc)},400)

    def do_GET(self):
        key = unquote(urlsplit(self.path).path)
        if key.startswith("/jobs/"):
            return self.json(JOBS.get(key[6:], {"error":"Unknown export."}))
        path = ROOT / (key.lstrip("/") if key != "/" else "ui/index.html")
        if not any(path.resolve().is_relative_to(d) for d in (ROOT/"ui",MEDIA,EXPORTS)) or not path.is_file():
            return self.send_error(404)
        size = path.stat().st_size
        start, end = 0, size-1
        match = re.fullmatch(r"bytes=(\d+)-(\d*)",self.headers.get("Range",""))
        if match:
            start = int(match[1])
            end = min(end, int(match[2])) if match[2] else end
            if start > end:
                return self.send_error(416)
        self.send_response(206 if match else 200)
        if match:
            self.send_header("Content-Range",f"bytes {start}-{end}/{size}")
        self.send_header("Accept-Ranges","bytes")
        self.send_header("Content-Type",mimetypes.guess_type(path)[0] or "application/octet-stream")
        self.send_header("Content-Length",str(end-start+1))
        self.end_headers()
        try:
            with path.open("rb") as f:
                f.seek(start)
                left = end-start+1
                while left:
                    chunk = f.read(min(1024*256,left))
                    if not chunk: break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (ConnectionResetError,BrokenPipeError,ConnectionAbortedError):
            pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8741)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not all(shutil.which(tool) for tool in ("ffmpeg","ffprobe")):
        raise SystemExit("Install FFmpeg and add its bin folder to PATH to run Aethrix.")
    from urllib.request import urlopen
    url = f"http://127.0.0.1:{args.port}"
    try:
        with urlopen(url, timeout=2) as response:
            if b"<title>Aethrix</title>" not in response.read(8192):
                raise SystemExit("Port is in use. Choose another with --port.")
    except OSError:
        pass
    else:
        if not args.no_browser:
            webbrowser.open(url)
        raise SystemExit(0)
    ThreadingHTTPServer.allow_reuse_address = False
    server = ThreadingHTTPServer(("127.0.0.1",args.port),Handler)
    server.authority = f"127.0.0.1:{server.server_port}"
    url = "http://"+server.authority
    print("Aethrix is running at "+url,flush=True)
    if not args.no_browser: webbrowser.open(url)
    server.serve_forever()
