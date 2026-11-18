# The Last Letter of Mist Harbor: Art and Audio Sources

Image Gen generated original main-story locations, Mira and Ren character art, and CGs for this work. The source imagery does not reproduce reference engines, commercial games, or other artists' work. The standalone character preview uses the official Live2D Hiyori sample under separate terms. Generated art has no hand-drawn artist credit and regeneration may produce different pixels. Original artwork is in `art/masters/`, with runtime images under `art/`. The story and art center on adult characters Mira, a 24-year-old mail carrier, and Ren, a 28-year-old lighthouse technician. [Live2D sample provenance, setup, and licensing](LIVE2D_SAMPLE.md)

## Generation Recipes and Outputs

The archived generation requirements summarize the original tool requests. The visual direction is detailed hand-painted visual novel illustration, with a misty harbor, vintage coastal railway, lighthouse, cool cyan-blue storm, and warm amber light. Frame artwork for portrait phones and reserve room for dialogue below. Exclude text, interface, watermarks, and existing IP.

Generation session: `01a1b110-c27f-7ca2-8fca-9fda16ae1a72`. The final column lists saved output basenames. Project masters are complete copies.

| Project file | Mode and visual requirements | Original generated file |
| --- | --- | --- |
| station.png | New opaque image. Midnight storm in the lighthouse station control room, with glass windows, an old radio, envelope, and amber desk lamp. Empty room. | exec-cd6493f6-22dc-4d9b-b880-7c1cf3ea93e1.png |
| archive.png | New opaque image. Damp archive with mailboxes, clockwork, and tide charts. Lighting matches the station. | exec-bb2b3e6f-beb9-4bfd-b561-592bb848bca1.png |
| roof.png | New opaque image. Lighthouse roof walkway, stormy harbor, brass signal lamp, and paper on the railing. | exec-dc1a9a4c-627a-4055-82a9-65ca0d07abda.png |
| dawn.png | New opaque image. Old platform after the storm, with sunrise, green train, misty harbor, and an envelope on a bench. Empty platform. | exec-bda073e0-c064-4650-a2d9-74b3dfaaf939.png |
| mira-neutral.png | New transparent sprite. Adult Chinese woman in a teal coat and burgundy scarf with a leather satchel and envelope, shown from the knees up. | exec-785d6ef8-677e-435c-beeb-7edd1ca14db4.png |
| ren-neutral.png | New transparent sprite. Adult Chinese man with glasses, work shirt, olive vest, tools, and a brass lantern, shown from the knees up. | exec-0ed60b0a-1b40-4a54-9933-a79ab9bf4856.png |
| mira-worried.png | Transparent edit of neutral. Worried expression, preserving identity, pose, framing, costume, and lighting. | exec-62055f06-e8b7-4863-9c7a-4a988b95deb2.png |
| mira-hopeful.png | Transparent edit of neutral. Relieved and hopeful expression, with other details preserved. | exec-f9ae9142-31b3-4190-b9ea-1bf7256d0721.png |
| ren-worried.png | Transparent edit of neutral. Worried expression, with other details preserved. | exec-30db6d81-b80b-4128-bd56-c3bcb7df192c.png |
| ren-hopeful.png | Transparent edit of neutral. Relieved and hopeful expression, with other details preserved. | exec-9e12e6f3-0ae2-4c43-8da9-82f0692cd44a.png |
| truth-letter.png | New opaque landscape illustration using both neutral sprites as identity references. Mira opens a twenty-year-old letter in the warmly lit control room. Ren is relieved, and the storm continues beyond the window. | exec-a9f1e65c-4afe-42b3-a8a0-45fbf6ecb42b.png |
| dawn-departure.png | New landscape illustration using both identity references. Mira looks back from a green train as Ren waves from the wet sunrise platform. Bittersweet and calm. | exec-1ca21f4b-e3de-479e-bfac-42abdc2bee8e.png |
| harbor-light.png | New landscape illustration using both identity references. They stand side by side at the lighthouse railing after the storm. Lamp light and clearing harbor convey warmth and hope. | exec-23322fb0-7759-4f10-8512-45555d3b1359.png |

Background and sprite masters are 1024×1536. CG masters are 1536×1024. Character sprites passed actual alpha inspection and native Guest visual acceptance with transparent backgrounds.

## Pinned Compiler Texture Constraints

This compiler and core revision raised static PAK IMG to 2048, with power-of-two dimensions. General textures, sprites, and tile uploads remain limited to 512. Original scenery and UI currently use 512 runtime images. Hiyori separately retains its original 2048 texture. `bun run prepare:art` uses macOS `sips -z 512 512` to generate runtime textures from each master, preserving the originals. Textures fill their UVs, and stage and CG draw dimensions restore aspect ratio. `images.json` enables linear sampling and retains RGBA8888. The smaller textures reduced resource load enough to omit optional RGBA4444 quantization and preserve translucent edge precision.

The final 2026-11-07 build had 21 images, 13 font slots, and one styles entry, totaling 35 PAK entries. PAK was 58,463,472 bytes with SHA-256 `9fcc419358ed70f2a83ca4ef2f8808a8d1c795ff6fb2b8165e438907a2d1a1d1`. QJBC was 988,548 bytes with SHA-256 `748913c419272953f049637630705f5d12c61ac07f8f6877372395faa1ae07fc`. PAK grew by 31,457,280 bytes compared with the earlier 512 Hiyori checkpoint. Memory and startup costs of the higher-resolution asset still require measurement. Three shared UI images carry about 3.15 MB of raw RGBA data. Icons share a 4×4 atlas, and the old ornate frame was removed from runtime registration. Generator outputs, source, and resource maps are reviewable inputs. QJBC and PAK are build artifacts. Editor and Guest share `novel.assets.json`, and builds preserve story and author edits.

## Weather and Interactive Artwork

Runtime resources `art/fx/sea-mist.png` and `art/fx/rain-streak.svg` supply fog and rain. Fog is one movable alpha layer. JS runs bounded rain simulation in one retained mesh. `art/ui/relay-dial.png` is original relay-dial artwork without numbers or options baked in. Runtime labels come from localized story text. [Weather masters, hashes, and SVG shapes](art/fx/PROVENANCE.md), [Dial masters, runtime hashes, and prompt](art/ui/RELAY_DIAL.md)

`novel.assets.json.choiceSurfaces` maps existing choice option IDs to normalized stage hotspots or touch areas over a dial image. It only selects existing story options. Freeform state, dragging, and collisions are outside this feature. Canvas and dial images reuse normal collection and the same 512 bake path. Targets under 44px or too small for localized labels fall back to the normal scrollable options list. [Editor and NativeSession selection evidence](../../../../sdk/docs/VISUAL_NOVEL_CHOICE_SURFACES.md)

The mockup is a design reference. The running game composes separate text, image skins, and actual controls. [Full GPT Image prompts, hashes, and bake steps for the mockup, refined frame, primary button, and atlas](art/ui/REFINEMENT.md)

## Original Audio and System Fonts

`bun run prepare:audio` runs `scripts/generate_audio.ts` and synthesizes PCM16 22050 Hz WAV from seeded noise and sine waves, without third-party recordings. Three music tracks are 24 seconds each, wind is eight seconds, and remaining effects include the station clock, relay switch and fault, and train departure. `text_narrator`, `text_mira`, and `text_ren` are low-volume sine/triangle cues about 45 ms long. JS plays them at a bounded rate based on actual visible text progress. They serve as text cues.

`bun run prepare:voice` creates spoken Chinese and English samples for Mira's original `arrival_02` dialogue, 13.60 and 12.37 seconds respectively. It uses pinned eSpeak NG 1.52.0 source and SHA-256 with offline CMake to produce mono PCM16 WAV. Runtime needs no TTS. These are intelligible synthesized voices with no actor recording or voice cloning. The script reads `story.json` and the sole `novel.locales.json` for dialogue. eSpeak source and build caches are ignored, licensed GPL-3.0-or-later, and excluded from the game. Version and source verification are in `scripts/generate_voice.ts`. Output audio uses original project text.

UI and dialogue render with native system vector fonts (`fonts: "host"`, `ui:fonts.host`, and `text.layout.native`). The repository and installation package omit embedded `.otf`/`.ttf` fonts and prebaked bitmap glyph libraries.

## Original Spine rig

`models/mira.spine.json` and `models/mira.atlas` are original Pocket authoring
sources over the existing Mira textures. They use a weighted 3×5 mesh, root,
torso and head bones, three expression skins, and idle/alert/settle motions.
No third-party model or Spine Editor application binary is bundled. Parsing,
pose calculation and mixing use the pinned official Spine runtime 4.3.13;
its license and integration conditions are recorded in
`sdk/docs/VISUAL_NOVEL_SPINE.md`. Model support does not grant a Spine license.

## Original Video Sequence

`assets/videos/archive-route-reel.mp4` is a silent three-second push into the mail-route chart in the project's original `art/archive.png`. It contains no real footage, third-party video, test bars, route labels, dialogue, or audio and uses the existing muted player. The clip gives the archive branch a brief old-film playback. The player must still check route seven on paper. Playback does not submit `found_route` or advance the story. Original artwork provenance appears above. No third-party assets or audio were added. [Reproducible FFmpeg 8.1.1 command, encoding parameters, and SHA-256](assets/videos/PROVENANCE.md)
