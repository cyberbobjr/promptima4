# Sound packs

The game's effects are the PC-speaker routines of the original (`src/audio/speaker.ts`, "classic"). A sound pack
replaces them with recorded sounds: Settings > Sound > Sound effects (`config.sound.pack`, default `modern`).

## Runtime (`src/audio/sounds.ts`)

- `assets/sounds/<name>/sounds.json`: `{ format: 1, name, events: { "<event>": { file } } }`, files next to it.
- The game keeps calling `playEffect(SFX.X, param)`; with a pack, `EFFECT_EVENTS` maps the effect to an event
  (`SFX.MAGIC` by its pulse width: 0xA0 moongate, 0xC0 healing / level up, else a spell) and the game waits as
  long as the original effect lasted, so the pacing is unchanged. `playEffect(..., event)` names a precise sound:
  the step taken carries its ground (`stepEvent`: grass, stone, wood, horse); the command click is silent.
- `cue(event)` plays the pack's own events the original has no sound for (door, chest, sailing); no-op in classic.
- Sounds overlap (no queue); steps, hits and blocked bumps vary their pitch by ±4% (sound random stream).

## Generation (ElevenLabs)

- Key: `ELEVEN_LABS_KEY=...` in `.env` (git-ignored). Client `tools/sounds/elevenlabs.mjs`.
- `node tools/sounds/sfx.mjs [name ...]`: the prompts (`SOUNDS`: prompt, duration, variants; shared `STYLE`
  suffix) → `test-output/sounds/sfx/<name>/<n>.mp3`, and a listening page `test-output/sounds/index.html`
  (dev server: http://127.0.0.1:1420/test-output/sounds/index.html). Model `eleven_text_to_sound_v2`, prompt
  influence 0.6. Cost: credits per second of sound (the 10,000-credit plan covered ~35 short effects).
- `tools/sounds/picks.json`: the variant kept per sound; a name instead of a number reuses another sound until
  that one is generated (stand-in).
- `node tools/sounds/build-sounds.mjs`: copies the picks to `assets/sounds/modern/` (versioned), each
  loudness-normalised with ffmpeg (`loudnorm=I=-18:TP=-1.5`), and writes `sounds.json`.

## Music

- Runtime `src/audio/music.ts`: `assets/music/<name>/music.json` (`{ format: 1, name, tracks: { "<scene>": { file } } }`),
  one looping track per scene, 2 s cross-fade on a change, streamed by audio elements once a gesture unlocked
  them. Scenes: title (no game yet), overworld, sailing (on a ship), town, castle (castle locations), dungeon,
  combat (combat layer), shrine (meditation), ending (`withScene("ending", ...)` around the Codex). A scene
  sharing its file with the previous one keeps playing. Settings: `config.music` (enabled, volume, pack);
  silent when `sound.enabled` is off (V).
- Tracks: Suno (instrumental), files in `test-output/music/<scene>.mp3`. `tools/sounds/music-picks.json` picks a
  file per scene, or `=<scene>` to reuse another scene's track until its own exists (stand-in).
- `node tools/sounds/build-music.mjs`: `assets/music/modern/` (versioned), loudness `I=-20` (under the effects),
  128 kbit/s.
- Suno prompts (Instrumental on), one generation per scene, the best of 2-3 kept:

| Scene | Prompt |
|---|---|
| title | Epic heroic fantasy main theme, full orchestra with choir pads, noble horns, harp arpeggios, hopeful and majestic, cinematic RPG title music, instrumental |
| overworld | Adventurous fantasy overworld exploration music, warm strings, flute melody, light percussion, sense of open lands and journey, medieval RPG soundtrack, seamless loop, instrumental |
| town | Cozy medieval town music, lute, recorder, hand drums, fiddle, cheerful and lively market atmosphere, fantasy RPG village theme, loopable, instrumental |
| castle | Regal medieval castle theme, stately brass fanfare, strings, harpsichord, dignified and calm, royal court of a wise king, fantasy RPG, loopable, instrumental |
| dungeon | Dark mysterious dungeon ambience music, low drones, distant percussion, eerie strings, sparse harp notes, tense and cavernous, fantasy RPG, loopable, instrumental |
| combat | Intense fantasy battle music, driving orchestral percussion, staccato strings, heroic brass stabs, fast tempo, RPG combat theme, loopable, instrumental |
| sailing | Seafaring fantasy sailing music, accordion and fiddle shanty feel, rolling strings, ocean breeze mood, adventurous, RPG ship theme, loopable, instrumental |
| shrine | Serene sacred meditation music, soft choir pads, singing bowls, gentle harp, ethereal and spiritual, peaceful shrine of virtue, fantasy RPG, instrumental |
| ending | Solemn epic finale, slow building orchestra and choir, transcendent and emotional, triumph of virtue, fantasy RPG ending theme, instrumental |
