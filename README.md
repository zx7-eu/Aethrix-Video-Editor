# Aethrix for Windows

Double-click **Aethrix.exe** to open the desktop editor. The executable contains the editor interface and the alpine sample project. The Rust application hosts the editor locally and displays it in a WebView2 window. It uses FFmpeg and FFprobe for media import and MP4 export. Both tools must be on PATH or in a bin folder beside the executable.

## Projects and media

The desktop window keeps its autosave in its own WebView2 profile. To bring a project over from the browser version, use **Project options → Save project file** in the browser, then **Project options → Open project file** in the desktop window.

When launched beside the existing media folder, the desktop editor uses that folder and writes finished renders to the neighboring exports folder. If moved elsewhere without a media folder, it creates its library under %LOCALAPPDATA%\Aethrix\Library. Existing installations reuse the previous profile and library. Aethrix opens both .framecut and .aethrix projects. Keep imported media with saved project files.

## Build from source

On Windows x64, install stable Rust with the MSVC toolchain and Microsoft C++ Build Tools. From this directory run:

    cargo build --locked --release

The result is target\release\aethrix.exe. Close the desktop editor before copying a rebuilt executable over Aethrix.exe. The native shell, media import, local serving, and export pipeline are implemented in src. The embedded editing interface is in ui.

## Edit with an AI agent

Open Aethrix.exe and keep the desktop window open. The same executable, launched with `--mcp`, serves MCP over standard input and output. The agent works on the project currently displayed in that window. The project includes a Codex configuration in `.codex/config.toml` and an example JSON client configuration in `.mcp.json`. If you move the executable, update its absolute path in your client configuration. For a desktop instance launched with a custom port, give the MCP process the same `--port` argument after `--mcp`.

An agent can use these tools:

- `inspect_project` reads asset IDs, clip IDs, source settings, markers, timeline positions, and the current revision.
- `import_media` adds a local media file to the library and returns its asset ID.
- `edit_timeline` inserts, trims, splits, reorders, removes, and grades clips. It also sets titles, speed, fades, soundtrack, timeline markers, project name, and aspect ratio. A batch uses the revision returned by inspection and becomes one desktop undo step. Refresh the inspection after a conflict.
- `preview_frame` seeks to a time in seconds and returns a JPEG from the composited preview.
- `export_video` starts an MP4 render of the specified revision at 720p, 1080p, or 2160p.
- `export_status` reports render progress and returns the finished MP4 path.

Example request for an agent: “Make a six-second vertical cut from the first two clips. Put a title on the opening shot, add a marker at the cut, and show me the frame at two seconds before exporting.”

## Timeline controls

Drag either edge of a video clip to trim it in frame increments. Following clips move with the cut. Press **M** to label the playhead position, then click a marker to revisit, rename, or remove it. Under **Inspector → Edit → Picture and sound fades**, set the fade durations in seconds. These fade the picture, titles, and clip audio together. Soundtrack volume remains independently adjustable.

## Clip motion

In **Inspector → Edit → Camera motion**, select **Push in**, **Impact settle**, or **Right-side detail**. The motion starts at the clip entrance and holds its final framing. Agents can set the same preset with the clip's `motion` setting. Both the preview and the Windows renderer read the frame counts, scale range, and framing anchors from `ui/motion.json`.

**Editing guide** opens the bundled [Shared Defaults](https://github.com/ericmjl/skills/blob/88bb4063eee5c215b0d70a5255ba467926ed5c28/skills/remotion-video/references/defaults.md) from the MIT-licensed remotion-video skill. The presets adapt its damped entrance and the frame-clamped, perceptual scale technique described in [Remotion's timing guide](https://github.com/remotion-dev/skills/blob/6f55706d1069e512430582ad86e4e57dc07afe1b/skills/remotion-markup/timing.md).
