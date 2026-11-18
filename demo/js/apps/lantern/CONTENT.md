# The Last Letter of Mist Harbor

## Story and play time

**The Last Letter of Mist Harbor** (雾港末班信) is a Chinese short visual novel that takes about 10–20 minutes to play. You are the night attendant at Mist Harbor Lighthouse Station. The storm will close the strait before midnight. Mira, a courier, arrives with a letter that has crossed twenty years, and repair technician Ren believes the old light-signal relay can no longer operate. Investigate old records, the platform clock, and the rooftop lens to decide how to send the letter.

The story moves from arrival through investigation and the storm climax to a resolution. Players choose the order of investigation. The puzzle and major decisions affect available options and endings. The script has 67 lines and 3,507 Chinese text characters. Allow about 10–15 minutes for a complete investigation, dialogue, choices, and staging pauses. Reading dialogue alone takes less time, and skipping read text makes it much shorter.

## Characters and content

- **You.** The attendant on duty at Mist Harbor Lighthouse Station. You can operate the platform clock, the optical relay, and the last train's mailbag.
- **Mira.** A courier who brings an old letter before the storm. She wants to deliver it while sparing people in the past from carrying the full burden of the future.
- **Ren.** The technician who repairs the light-signal relay. Since a storm twenty years ago, he has believed he missed the warning.

The story includes a storm, memories of a maritime accident, separation, and unfulfilled promises. It contains no death scene and leaves moral decisions to the player.

## Story nodes and conditions

| Act | Node | Main state changes | Observable result |
|---|---|---|---|
| Arrival | `arrival` | Initializes `found_route`, `found_clock`, `found_lens`, `mira_trust`, `proof_complete`, `dial_*`, and `code_misses`. | Mira arrives. The player establishes the timing of the last train and storm. |
| Investigation | `station` / `archive` / `roof` | Find route digit 7, single pulse 1, and final storm log digit 4. Decide whether to hear Mira's explanation. | If any clue is missing, the relay dial explains what is missing and returns to investigation. |
| Archive film | `archive_reel_entry` | Plays an original three-second silent clip slowly pushing in on the archive's postal route map. | Leaves `found_route` unchanged and never completes or advances dialogue automatically. The player can pause, seek back one second, replay, or close. Story progress waits for input. |
| Reply tag | `registry_open` / `registry_public_yes` / `registry_public_no` | Find at least one clue to register a recipient name (1–16 Unicode characters), integer reply box 0–999, and whether the signature is public. Each valid submission writes `reply_name`, `reply_box`, or `reply_public`. | Invalid input stays in the field. Cancellation returns to the hub without writing the unsubmitted value. This branch leaves puzzle state and ending requirements intact. |
| Puzzle | `dial_first` / `dial_second` / `dial_third` | Player sets three digits. | Only all three clues plus `714` set `proof_complete=true`. A wrong code uses one relay opportunity and leaves one retry. |
| Climax | `signal_window` | `proof_complete` and `mira_trust` govern the true-ending option within a limited storm window. | Timeout sounds the evacuation alarm. The characters are safe, but the letter misses its window. |
| Resolution | `ending_truth` / `ending_train` / `ending_shelter` | Each ending sets its own CG and music request. | The letter crosses time, departs on the last train, or stays at the station with the lightkeepers. |

`memory_note` is a reusable call/return fragment reached by asking Mira in the archive or on the roof. The first visit gives the full recollection. Later visits acknowledge she has already told it. Audio cues request playback. Story state never depends on whether playback succeeds.

The reply tag is optional and only appears after finding a clue. It leaves the first dialogue line at `start[17]`, the investigation order, puzzle 714, all three endings, and the default last-train route in place. The name, integer box number, and public-signature confirmation use text, number, and boolean input. `registry_recipient` and `registry_mailbox` have story-specific placeholders, and the boolean shows explicit **Yes** and **No** options. Cancel the current field to return to the hub while keeping earlier submissions and discarding the current draft.

## Complete routes through all three endings

Each manual route starts from a new game. The option text can vary as long as the behaviors below remain available.

### A. True ending · `truth_letter` CG

1. Choose to inspect the old route map at the platform. Cross-check the old postal route in the archive for `found_route` and relay port **7**.
2. Return to the platform. Inspect the clock stopped at 23:14 and the single-ring bell circuit for `found_clock` and pulse **1**.
3. Inspect the rooftop lens and storm log for `found_lens`. Take the final digit **4** from 23:14. Checking the seal in the opening or choosing to trust Mira in `memory_note` can increase `mira_trust`. The correct code leaves that decision to the player.
4. Return to the relay dial and select **7 → 1 → 4**. Exercise all three actual dial choices and their conditional branch.
5. Within the `signal_window` time limit, send the decoded letter back twenty years. After one wrong code, the remaining retry still unlocks this outcome with **714**.
6. Reach `ending_truth`. Mira confirms delivery and Ren releases twenty years of guilt. This unlocks `truth_letter`.

### B. Last-train ending · `dawn_departure` CG

1. Choose the last train directly in the investigation hub or enter two wrong codes in the puzzle.
2. In the final storm window, place the letter in the last train's waterproof mailbag. Letting the timer expire also reaches the letter-on-the-train outcome by way of the default evacuation.
3. Reach `ending_train`. Mira leaves on the last train. The letter reaches a real address in the present and unlocks `dawn_departure`.

### C. Stay to keep the light

1. In the timed final storm choice, sound the alarm and stay to keep the lighthouse on. Timeout instead prioritizes passenger evacuation and automatically enters the last-train ending. It closes this option.
2. Reach `ending_shelter`. Mira and Ren put the unsent envelope in the station's archive cabinet. The past stays as it was, and together they wait for dawn.

## Combining the puzzle clues

Combine facts from three scenes in relay-dial order to get **714**.

| Dial position | Source | Inference | Digit |
|---|---|---|---:|
| First, old postal route | Strait postal map in the archive | Only route 7 connects to the light-signal relay. | 7 |
| Second, relay pulse | Platform control box | One ring confirms the line. Two rings signal closure. | 1 |
| Third, time check | Rooftop storm log | The key tide level was at 23:14. The panel uses the last minute digit. | 4 |

The engine sets `proof_complete` only when `found_route && found_clock && found_lens && dial_1 == 7 && dial_2 == 1 && dial_3 == 4`. Each wrong sequence uses a signal window, plays a circuit-break cue, and advances the story. A second miss locks the time-crossing branch. The last-train and lighthouse endings remain available.

## Asset keys

These are logical keys in `novel.assets.json`. See [ASSETS.md](ASSETS.md) for file paths and provenance. If a resource is missing, surface the error and leave playback and decode status truthful.

| Type | Logical key | Use |
|---|---|---|
| Background | `station` | Platform, night-shift opening, and relay dial. |
| Background | `archive` | Archive investigation and postal map. |
| Background | `roof` | Rooftop lens and storm window. |
| Background | `dawn` | Dawn resolution for all three endings. |
| Actor | `mira` | `neutral`, `worried`, and `hopeful`. |
| Actor | `ren` | `neutral`, `worried`, and `hopeful`. |
| CG | `truth_letter` | The true-ending letter reaches the past through the signal. |
| CG | `dawn_departure` | The last train leaves the fog. |
| CG | `harbor_light` | The lighthouse stays lit after the storm. |
| Video cue | `archive_route_reel` | Original silent film for the archive branch, animated as a slow push-in on the archive painting. |
| Audio cue | `music_storm`, `music_letter`, `music_dawn` | Chapter score requests on `music`. The first two loop. |
| Audio cue | `roof_gust` | Looping rooftop wind on `ambience`. |
| Audio cue | `station_bell`, `relay_click`, `relay_break`, `train_depart` | `sfx` cues for bell, dial success, line failure, and train departure. |
| Audio cue | `text_narrator`, `text_mira`, `text_ren` | Optional synthesized text sounds for narrator, Mira, and Ren, reusing `effect-0..3`. |

The settings page offers master, music, effects, and voice volume. Click to cycle through 0%, 25%, 50%, 75%, and 100%. Master gain multiplies the category gain. `music` uses music. The reserved `__pocket_vn_voice` channel uses voice. `ambience`, `sfx`, one-shot effects, and other custom channels use effects. Master defaults to 70% and the others to 100%, preserving original gain. The mix persists in `lantern.audio.mix`. Changing a currently playing channel sends a gain update and preserves position. A new game stops current story audio and follows the new opening intent, resets puzzle progress, and retains read metadata.

The same page offers optional text sounds, off by default and stored in `lantern.audio.textSoundsEnabled`. Visible non-whitespace text can trigger a speaker-specific short sound at most once every 100 ms. Narrator, Mira, and Ren have separate locally generated WAVs under the existing effects mix and four shared channels. Reveal-all, skipping, instant text, whitespace, and backgrounding do not replay accumulated sounds. These cues are short synthesized tones. See [glyph audio source and verification](../../../../sdk/docs/VISUAL_NOVEL_GLYPH_AUDIO.md).

## Ending replays and music previews

The gallery keeps three ending-gated replays after the CGs and adds a true-ending unlock for **Old Film of Postal Route 7** (七号邮路旧胶片). Entries start at actual scene instructions in their story sections. Replay copies the current engine's public variables, metadata, and reading preferences to a temporary engine. Replay video requests and variable changes leave the main save untouched. Exit returns to the title or journey position from which the gallery opened.

The gallery lists tracks recorded in main-story metadata that still exist in the asset registry. Previews and replay scores share one host `music-preview` channel. They pause the original `music` player and resume that same player when the preview stops or replay exits, preserving position. The integration uses the existing player and JS state.

English replay titles use stable IDs in `novel.locales.json` under `replays`. The four titles and entry positions stay in `story.json`, preserving original opening dialogue, investigation clues, puzzle 714, and the default last-train ending. See [gallery replay source, isolation, and real host acceptance](../../../../sdk/docs/VISUAL_NOVEL_GALLERY_REPLAY.md).

## Capability matrix

| Engine or player feature | Node | Manual or automated verification |
|---|---|---|
| Background and actor scenes | `arrival`, three locations, and three endings | Inspect `scene` snapshot background, actor position, expression, and removal. |
| Stable dialogue and narration IDs | All `say` instructions | Every `say.id` is unique. Check backlog ordering across nodes. |
| Variables, conditions, and branching | Clues, trust, puzzle checks, and ending choices | `story.test.ts` executes missing-clue, incorrect-code, and correct-code routes. |
| Timed choice and timeout | `signal_window` | `tick` beyond `timeLimitMs` and confirm default evacuation and missed letter window. |
| Call and return | `memory_note` | Enter from archive and roof and verify return to the respective caller. |
| Wait and tick | Bell, storm arrival, and ending pause | Remain waiting before the duration and continue after reaching it. |
| Audio request events | Scene audio cues | The engine emits requests. Actual playback is a host observation. |
| Video controls and native observations | `archive_reel_entry` | The actual player reports ready/ended for nonlooping playback. Once duration is known, pause, seek back one second, replay, or close. Natural end leaves dialogue in place. Uninitialized decoders cannot signal completion. |
| Ending and CG unlock metadata | `ending_truth`, `ending_train`, and `ending_shelter` | Reach each ending and check its ending ID and CG. |
| Save/load, rollback, skip read text, and auto | Game UI | UI calls public engine APIs. `story.test.ts` checks JSON story import, save/load, rollback, preference switching, and prevention of auto, skipping, or paused time bypassing player input. |

Replay, rollback, saves, skip read text, and auto combine game controls with public engine APIs. The story reuses the engine's history and preferences. `story.test.ts` walks through formal snapshots, choices, tick, and save/load/rollback. The UI provides interactive controls. Native input is covered separately by `demo/js/tests/novel_input_native.test.ts` and Flutter system IME tests. See `sdk/docs/VISUAL_NOVEL_INPUT_ACCEPTANCE.md` for sources and scope.

## Through the Fog transitions

Open the standalone **Through the Fog** (穿雾换景) showcase from the title. The platform reveals left to right, the archive right to left, the roof top to bottom, and dawn bottom to top, each over 1.2 seconds. Dialogue and Back remain fixed above the stage. Click Continue to reach the next image. Existing replay isolation returns the main journey to the same position, leaving story instructions, v6 cursors, and endings intact. The entry and four dialogue lines are localized in Chinese and English. See `sdk/docs/VISUAL_NOVEL_REVEAL.md` for runtime, editing, and acceptance scope.

## Lighthouse Ensemble

The title has an independent **Lighthouse Ensemble** (灯塔合奏) replay. The six-second `beacon_sweep` preset uses the existing story clock to push the camera in, move, scale, and rotate Mira, and cue three sounds: sea wind, platform bell, and relay. The rooftop scene reuses the preset. The final part cancels it explicitly and returns to a still composition. Continue to interrupt the performance. Original main-story instructions, v6 cursors, and migration maps are preserved. Existing replay isolation keeps the journey save intact. See [timeline implementation and acceptance scope](../../../../sdk/docs/VISUAL_NOVEL_TIMELINE.md).

### Second movement

Three Chinese and English lines extend Lighthouse Ensemble. The camera approaches the rooftop again and `harbor_crescendo` carries the sea wind from silence to 0.85 and back to silence, with the bell crossing the strait in between. The channel stops after six seconds, on early Continue, or on Back. It leaves no wind loop. Gain multiplies the player's master and effects gains. New material is appended in source order after the existing instructions, and old migration maps are preserved. See [audio envelopes](../../../../sdk/docs/VISUAL_NOVEL_AUDIO_ENVELOPES.md).
