75 ferramentas. Ações = valores do parâmetro `action`.

### Status e projeto

| Ferramenta | Ações / uso |
|---|---|
| `premiere_status` | Connection, Premiere version, open projects, active sequence, open dialogs, backends (CEP/UXP) and routes. |
| `bridge_stats` | Local telemetry: calls, errors, average/max time per host function (round trip and inside Premiere), queue depth, recent errors, backends. |
| `jobs` | `status`, `wait`, `list`, `cancel` — Follow async: true tools. |
| `checkpoint` | `create`, `list`, `diff`, `restore` — create: clone the sequence as '<name> [checkpoint hh:mm:ss]' and keep a snapshot of its clips (clone: false keeps only the snapshot). |
| `get_project` | Project name/path, item counts, sequences and the active sequence (size, fps, duration, tracks, playhead). |
| `project_file` | `save`, `save_as`, `open`, `new`, `close`, `close_others` — Save, save-as, open, create or close a project. |
| `project_tools` | `backup`, `consolidate_and_transfer`, `consolidate_duplicates`, `scratch_disks`, `smart_bin`, `structure`, `organize` — backup (copy the .prproj to a dated file; max_mb limit), consolidate_and_transfer (Project Manager: copy used media + project to a folder), consolidate_duplicates, scratch_disks (preview/autosave folders), smart_bin (search query), structure (bins and media counts by kind), organize (sort items into bins by kind: preview first, nothing is deleted). |
| `list_project_items` | List bins, clips and sequences with their ids (filter by bin, type, name regex). |
| `search_items` | Find project items by name (substring), regex, extension, type, color label, offline, used/unused in sequences, or bin. |
| `get_item_info` | Details of one project item: media path, duration, in/out, fps interpretation, markers count. |
| `import_media` | Import files, a folder (optionally mirrored as bins) or a timeline/project (interchange: FCP XML, EDL, AAF, .prproj, AE comps). |
| `replace_media` | Point a project item at a new file (all timeline uses update). |
| `manage_bins` | `create`, `move_items` — Create bins (nested paths) or move items into a bin. |
| `manage_project_items` | `rename`, `delete`, `label`, `set_in_out`, `clear_in_out`, `interpret`, `refresh`, `subclip` — Rename, delete, set color label, set/clear source in/out, set frame-rate interpretation, refresh media, or create a subclip. |
| `media` | `relink`, `set_offline`, `create_proxies`, `attach_proxy`, `detach_proxy`, `proxy_status`, `proxies_enable`, `interpret`, `scale_to_frame`, `color_space`, `input_lut`, `watch_folder`, `stop_watch`, `list_watches`, `poster_frame`, `audio_channel_mapping` — Media of project items. |
| `metadata` | `get`, `set`, `label`, `add_field` — Read or write clip metadata of project items: Log Note, Scene, Shot, Take, Description, Good (XMP, what the Metadata panel shows) and custom project-panel fields; color labels in bulk; add_field creates a custom project metadata field. |
| `inspect` | `project_overview`, `sequence`, `clip`, `timeline_summary`, `gaps`, `health`, `used_media`, `unused_media`, `duplicates`, `offline`, `state` — Read project/timeline facts. |

### Sequências e trilhas

| Ferramenta | Ações / uso |
|---|---|
| `list_sequences` | All sequences with id, size, fps, duration, track counts; marks the active one. |
| `open_sequence` | Open a sequence and make it active. |
| `create_sequence` | Create a sequence without dialogs: width/height/fps (e.g. |
| `manage_sequence` | `rename`, `duplicate`, `delete`, `settings`, `get_settings`, `range`, `zero_point`, `format`, `custom_property` — Rename, duplicate, delete, change settings (frame size/fps/sample rate), or set in/out, work area and playhead. |
| `sequence_tools` | `subsequence`, `auto_reframe`, `scene_edit_detection`, `nest`, `unnest`, `render_previews`, `delete_previews` — Advanced sequence operations: nest clips in place (their range on their tracks becomes a nested sequence), unnest (put a nest's clips back; effects not carried), render_previews / delete_previews, nest a range into a subsequence, Auto Reframe to another aspect ratio (e.g. |
| `manage_tracks` | `add`, `delete`, `set`, `target_all`, `target_none` — Add video/audio tracks, delete a track, or set mute/lock/target/name on tracks. |

### Timeline

| Ferramenta | Ações / uso |
|---|---|
| `get_timeline` | Sequence snapshot: tracks with clips (id, name, start/end, in/out, effects, media) and transitions. |
| `find_clips` | Find timeline clips with a selector (tracks, name_regex, at, selected, every_nth...). |
| `place_clips` | Build a timeline in ONE call: many items with in/out, duration, track, transform, effects, keyframes, properties, volume. |
| `edit_clips` | `move`, `move_to_track`, `trim`, `set`, `link`, `unlink`, `slip`, `slide`, `roll`, `ripple_trim`, `duplicate`, `freeze_frame`, `lift_range`, `extract_range`, `split_edit`, `batch_rename` — Edit clips (linked audio follows unless include_linked:false; checked before editing). |
| `remove_clips` | Delete clips (lift, or ripple: true to close the gap); linked clips too unless include_linked:false. |
| `ripple_delete_ranges` | Remove many time ranges with ripple in one call (e.g. |
| `razor` | Cut at one or many times on all tracks or given tracks (linked clips cut too unless include_linked:false). |
| `set_clip_speed` | Change clip speed / reverse (QE). |
| `close_gaps` | Ripple clips on given tracks left so no gaps remain (from an optional time). |
| `select_clips` | Select clips in the timeline (e.g. |
| `source` | `open`, `state`, `close`, `insert`, `overwrite`, `match_frame` — open an item in the Source Monitor (with in/out), state, close, insert / overwrite the source into the targeted tracks (or video_track/audio_track) at time or the playhead, match_frame (open the source of the clip under the playhead and report its media time). |
| `playhead` | `next_edit`, `prev_edit`, `next_marker`, `prev_marker`, `clip`, `start`, `end`, `play`, `stop`, `workspace` — Get/set the playhead (seconds) or action: next_edit, prev_edit, next_marker, prev_marker, clip (edge), start, end, play, stop, workspace (name). |
| `markers` | `list`, `add`, `delete`, `update`, `export`, `import` — Sequence (or item) markers: list (type/color filter), add (batch), delete, update, export (csv | youtube chapters), import (CSV/TXT notes with timecodes). |

### Efeitos, cor e keyframes

| Ferramenta | Ações / uso |
|---|---|
| `list_available_effects` | List effect / transition names exactly as this (possibly localized) Premiere knows them. |
| `get_clip_effects` | Components on clips with every property value and keyframes (times relative to clip start). |
| `apply_effects` | Add effects to many clips, optionally with params: [{name:'Gaussian Blur', params:{Blurriness:30}}]. |
| `remove_effects` | Remove named effects (or all non-intrinsic effects) from clips. |
| `set_properties` | Set any effect parameter on many clips (static, or a single key with time). |
| `set_transform` | Motion/Opacity in friendly units on many clips: scale %, position px, rotation, anchor, opacity %, crop %, blend_mode by name. |
| `add_keyframes` | Animate properties on many clips; key times are seconds from each clip's start (or 'end', or sequence time with time_base). |
| `remove_keyframes` | Remove all keyframes of a property (keeps the current value), or only within a clip-relative time range. |
| `keyframe_tools` | `list`, `value_at`, `interpolation`, `move`, `scale` — Work on existing keyframes of a property on many clips (times are seconds from each clip's start). |
| `copy_effects` | Paste-attributes: copy effects, Motion/Opacity values and keyframes from one clip to others. |
| `list_effect_presets` | List the user's saved Effect Presets (from Premiere's preset file) with their effects. |
| `apply_effect_preset` | Apply a saved Effect Preset (by name or bin path, e.g. |
| `add_transitions` | Add a video or audio transition at the start/end/both of many clips (default Cross Dissolve / Constant Power). |
| `color` | `basic`, `read`, `match_shot`, `auto_balance`, `apply_lut`, `look` — Lumetri color on many clips. |
| `stabilize` | `apply`, `status` — Apply Warp Stabilizer to clips and wait for Premiere's analysis (use async: true for long clips). |
| `adjustment_layer` | Place an adjustment layer with a duration and effects (or a preset). |
| `scopes` | Measure a rendered frame of the sequence (luma mean/min/max, RGB means, crushed blacks / clipped whites %, color cast) to check exposure and color without looking. |
| `mask_fit` | Frame a rectangle of the clip (face, object) to fill the sequence frame or a target box: computes Motion scale and position and applies them (static, or keyframed between from and to rects). |

### Áudio

| Ferramenta | Ações / uso |
|---|---|
| `set_volume` | Set clip level (db) or a dB envelope (keys [{t, db}]). |
| `fade_audio` | Fade audio clips in/out with volume keyframes (language-independent). |
| `audio` | `pan`, `gain`, `mute`, `unmute`, `solo_track`, `normalize`, `loudness`, `duck`, `detect_beats`, `detect_transients`, `effect`, `channel_mapping` — Audio on many clips. |
| `analyze_media` | `probe`, `silence`, `scenes`, `loudness`, `frames` — Analyze a media file locally with FFmpeg (no Premiere needed): probe streams, detect silences (for jump cuts), detect scene cuts, measure loudness (LUFS), or grab source frames as images. |

### Texto, gráficos e legendas

| Ferramenta | Ações / uso |
|---|---|
| `create_title_image` | Render a transparent PNG title with any .ttf/.otf font (e.g. |
| `mogrt` | `import`, `get_params`, `set_params`, `batch` — Import a .mogrt onto the timeline (with text/params filled in; save_recipe keeps it for reuse), batch (many MOGRTs or recipes with different params in one call), read its editable params, or set params on existing MOGRT clips. |
| `import_captions` | Import an .srt/.scc/.vtt file and create a caption track on the sequence. |
| `captions` | `create_track`, `read`, `edit`, `retime`, `export`, `safe_zone_check`, `burn_style` — Captions from transcripts or subtitle files. |
| `transcribe` | Local word-level transcription (faster-whisper; no upload). |

### Revisão e entrega

| Ferramenta | Ações / uso |
|---|---|
| `export_frames` | Render sequence frames at times and SHOW them (contact sheet when >2) to verify edits visually; PNGs are kept on disk. |
| `review` | Contact sheet of review frames with timecodes: at every marker (by: markers), at the middle of every clip of a selector (by: clips), or every N seconds (by: interval). |
| `export_sequence` | Render a sequence to a file with an .epr preset (default H.264 Match Source), directly or via Media Encoder (wait: true waits for the file). |
| `list_export_presets` | Find .epr export presets installed with Premiere / Media Encoder. |
| `export_interchange` | Export the sequence as Final Cut Pro XML (no 'Translation Report' dialog), CMX3600 EDL, AAF, OMF (audio), or a .prproj with just this sequence (project). |
| `deliver` | `matrix`, `verify`, `export`, `by_markers` — Delivery for platforms. |
| `encode` | `item`, `sequence`, `file`, `launch`, `start` — Queue work in Adobe Media Encoder: a project item (item), a sequence, or a loose file (file) with an .epr preset; launch AME; start the queue. |

### Automação

| Ferramenta | Ações / uso |
|---|---|
| `auto_edit` | `jump_cut`, `remove_fillers`, `beat_montage`, `emphasis_zoom`, `multicam`, `speaker_reframe`, `shorts`, `chapters`, `mix`, `sync_audio`, `visual_qa`, `paper_edit` — Edits that run end to end (preview: true shows the plan without editing; checkpoint: true clones the sequence first). |
| `recipes` | `list`, `get`, `save`, `delete`, `run` — Reusable workflows: a JSON list of tool calls with {{param}} placeholders ({{steps.<save>.<field>}} reads an earlier step's result). |
| `batch` | Run several tool calls in order (stops at the first error unless continue_on_error). |
| `undo` | Undo/redo whole tool calls: calls: N (default 1) rewinds Premiere's steps and the DOM edits of the last N calls; redo: true redoes them; steps: N is raw Ctrl+Z; history: true lists recorded calls. |
| `run_extendscript` | Escape hatch: run ExtendScript in Premiere. |

