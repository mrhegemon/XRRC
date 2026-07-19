# XRRC Rally Circuits

[![Test](https://github.com/mrhegemon/XRRC/actions/workflows/tests.yml/badge.svg)](https://github.com/mrhegemon/XRRC/actions/workflows/tests.yml)
[![Deploy GitHub Pages](https://github.com/mrhegemon/XRRC/actions/workflows/pages.yml/badge.svg)](https://github.com/mrhegemon/XRRC/actions/workflows/pages.yml)

XRRC is a static-first Three.js RC racing game for desktop, mobile, private
WebRTC multiplayer, native WebXR, and 8th Wall AR. Choose one of six themed
circuits and 13 vehicles, then race without an application backend. The optional
Node service only handles WebRTC signaling and is designed to stay private
behind Tailscale Serve.

**Play:** [lab.liambroza.com/XRRC](https://lab.liambroza.com/XRRC/)

![XRRC lobby with course and vehicle setup](docs/screenshots/lobby-desktop.png)

![Expanded XRRC rally circuit in desktop mode](docs/screenshots/race-desktop.png)

## Highlights

- Responsive lobby and HUD with English, Spanish, and French localization.
- Six spline circuits with distinct racing lines, scenery, palettes, lighting,
  and trackside props - hairpins, sweepers and direction changes rather than
  six variations on an oval.
- Seven handling classes plus six on-demand GLB rally-car skins.
- Asphalt, shoulders, curbs, grid markings, four ramps, and a vertical stunt
  loop - all placed on the racing line itself, so a lap runs through them
  instead of detouring to a separate stunt strip.
- Road and off-road traction, registered prop collisions, real airborne arcs,
  landing impacts, ordered checkpoints, wrong-way feedback, and automatic recovery.
- Configurable one-, three-, or five-lap races with sector timing, live
  standings, results, local records, and personal-best ghosts.
- Up to five deterministic spline-following solo rivals, drift-earned boost,
  skid marks, speed-sensitive camera feedback, steering assist, and pause/retry.
- Keyboard, touch, standard Gamepad/XInput, and Quest-style XR controls.
- Synthesized engine, skid, impact, countdown, and music audio with impact
  vibration and controller rumble.
- Private-room WebRTC with origin-restricted signaling, health checks,
  reconnects, sequence validation, interpolation, short-horizon prediction, and
  reliable race milestones.
- A pit-pass invite dialog with a locally rendered QR code, copy, native share,
  email, text, and WhatsApp actions.
- Native immersive WebXR and an on-demand 8th Wall camera pipeline.
- A Quest quality profile and instanced track props that keep the reference
  scene within the automated render budget.
- 65 Node tests, 37 Playwright browser tests, CI, and deterministic screenshots.

## Visual gallery

### Six themed circuits

| Backyard Rally | Alpine Pass | Desert Run |
| --- | --- | --- |
| ![Backyard Rally circuit](docs/screenshots/track-backyard.png) | ![Alpine Pass circuit](docs/screenshots/track-alpine.png) | ![Desert Run circuit](docs/screenshots/track-desert.png) |

| Neon Harbor | Sakura Sprint | Lunar Circuit |
| --- | --- | --- |
| ![Neon Harbor circuit](docs/screenshots/track-harbor.png) | ![Sakura Sprint circuit](docs/screenshots/track-sakura.png) | ![Lunar Circuit](docs/screenshots/track-lunar.png) |

### Vehicle classes

| Rally car | Dune buggy | 4x4 truck |
| --- | --- | --- |
| ![Rally car on the XRRC circuit](docs/screenshots/race-rally.png) | ![Dune buggy on the XRRC circuit](docs/screenshots/race-buggy.png) | ![4x4 truck on the XRRC circuit](docs/screenshots/race-truck.png) |

| RC motorcycle | Mini tank | Prop plane |
| --- | --- | --- |
| ![RC motorcycle on the XRRC circuit](docs/screenshots/race-motorcycle.png) | ![Mini tank on the XRRC circuit](docs/screenshots/race-tank.png) | ![Prop plane over the XRRC circuit](docs/screenshots/race-plane.png) |

| Helicopter |
| --- |
| ![Helicopter over the XRRC circuit](docs/screenshots/race-helicopter.png) |

| Racer 1 | Racer 2 | Racer 3 |
| --- | --- | --- |
| ![Racer 1 on the XRRC circuit](docs/screenshots/race-toy-car-1.png) | ![Racer 2 on the XRRC circuit](docs/screenshots/race-toy-car-2.png) | ![Racer 3 on the XRRC circuit](docs/screenshots/race-toy-car-3.png) |

| Taxi | Police | Coupe |
| --- | --- | --- |
| ![Taxi on the XRRC circuit](docs/screenshots/race-toy-car-taxi.png) | ![Police car on the XRRC circuit](docs/screenshots/race-toy-car-cop.png) | ![Coupe on the XRRC circuit](docs/screenshots/race-car1.png) |

### Localization, mobile, and multiplayer

| Spanish setup | Mobile setup | Mobile race |
| --- | --- | --- |
| ![XRRC lobby localized in Spanish](docs/screenshots/lobby-spanish.png) | ![XRRC mobile race setup](docs/screenshots/lobby-mobile-setup.png) | ![XRRC touch controls during a race](docs/screenshots/race-mobile.png) |

| Private relay setup | Tank peer | Helicopter peer |
| --- | --- | --- |
| ![Tailscale multiplayer relay setup](docs/screenshots/multiplayer-setup.png) | ![Tank view in a two-peer room](docs/screenshots/multiplayer-tank.png) | ![Helicopter view in a two-peer room](docs/screenshots/multiplayer-helicopter.png) |

## Quick start

XRRC requires Node.js 18 or newer.

```bash
npm ci
npm start
```

Open <http://127.0.0.1:3000>. Local pages automatically use the bundled
signaling service; clear the multiplayer relay field or add `?signal=off` for a
solo race.

The browser imports Three.js and Google Fonts from their CDNs. The QR renderer
is fetched only when **Invite** is opened, and the 8th Wall packages are fetched
only when **Use 8th Wall** is selected.

## Player reference

### Start a heat

1. Choose a language, course, vehicle, track props, lap count, solo rival count,
   and steering-assist preference.
2. Leave the relay blank for solo play, or enter and test a shared HTTPS
   Tailscale Serve URL for multiplayer.
3. Select **Start WebXR**, **Race on desktop**, or **Use 8th Wall**.
4. In AR, place the course on a detected surface. The countdown starts once the
   course is placed.

Ramps, loop, and street-kit props can be enabled independently. Ramp and loop
positions are derived from each circuit's own spline at load time - the loop
takes the longest straight and the ramps spread around the lap - so they always
sit on the racing line whichever course is selected.

### Race rules, rivals, and records

The default heat is three laps with three solo rivals. One- and five-lap formats
and zero or five rivals are also available. AI racers follow the selected course
deterministically, adapt modestly to the field without teleporting, collide with
an actively driven on-course vehicle, and appear in the live standings.
Multiplayer disables AI so each standings entry represents a real peer.

Each valid lap must cross three ordered checkpoints before returning through the
start line. The HUD tracks four sector splits, current race time, lap progress,
position, and the best locally saved lap for that circuit. Finishing opens the
official timing sheet with lap breakdown, final position, race-again, and
return-to-lobby actions.

The fastest valid lap per course is stored in `localStorage` with its best sector
splits and a sampled trajectory. On later laps, that trajectory replays as a
translucent, non-colliding personal-best ghost. Records stay on the device and
do not require the signaling service.

### Circuits

| Course | Character | Scenery |
| --- | --- | --- |
| Backyard Rally | Broad dirt-lab baseline | Trees, hay, flags, and workshop props |
| Alpine Pass | Technical switchbacks | Snow banks, pines, and summit markers |
| Desert Run | Fast, dusty sweepers | Cacti, canyon rocks, and utility props |
| Neon Harbor | Angular night route | Containers, dock lights, and harbor equipment |
| Sakura Sprint | Flowing garden bends | Blossom trees, lanterns, and stone details |
| Lunar Circuit | Dark low-gravity fiction | Craters, beacons, rocks, and antenna props |

Every course uses its own spline, road width, palette, fog, lighting, sign, and
instanced scenery set. The shared 1.42 course scale produces a 5.89 by 4.47
world-space driving envelope while leaving vehicle dimensions unchanged.
Invitations and network rooms carry the selected course so peers cannot join a
room using a different layout.

### Vehicles

| Selection | Model | Handling |
| --- | --- | --- |
| Rally car | Procedural | Balanced baseline |
| Dune buggy | Procedural | Quick acceleration, tighter steering, lively bounce |
| 4x4 truck | Procedural | Lower speed, slower steering, heavier response |
| RC motorcycle | Procedural | Fastest ground vehicle with sharp steering |
| Mini tank | Procedural | Slow, stable, and able to pivot turn |
| Prop plane | Procedural | Fast air vehicle with wide steering |
| Helicopter | Procedural | Hovering air vehicle with agile pivot turns |
| Racer 1, Racer 2, Racer 3 | GLB skins | Rally physics |
| Taxi, Police, Coupe | GLB skins | Rally physics |

The setup panel publishes localized speed, launch, handling, and stability
ratings plus a role and driving note for every selection. The seven procedural
classes have separately tuned acceleration, steering floor, drift threshold,
drag, bounce, ride height, and stability behavior. GLB bodies intentionally use
the balanced rally tune.

GLB models are loaded from `public/assets/cars/` only when needed. A procedural
rally body is shown until loading completes and remains as the fallback if an
asset cannot be loaded. Vehicle type is included in network state, so peers
render the same procedural model or skin.

The in-race bay renders a cached thumbnail for all 13 vehicles. Selecting an
empty slot transfers the current race position to that vehicle and returns the
previous vehicle to its fixed paddock stall. Selecting a parked slot recalls
and disposes that vehicle. Selecting the active slot is a no-op.

### Controls

| Device | Drive | Steer | Altitude | Reset | Pause |
| --- | --- | --- | --- | --- | --- |
| Keyboard | `W` / Up, `S` / Down | `A` / Left, `D` / Right | Space / `E` rises, Shift / `Q` descends | `R` | Escape |
| Touch | Joystick or **GO** / **REV** | Joystick or **L** / **R** | **UP** / **DN** for aircraft | HUD **Reset** | HUD **Pause** |
| Standard gamepad | Triggers, D-pad, face buttons, or left-stick Y | Left-stick X or D-pad | Right / left bumper | B | Menu |
| Quest-style XR | Right trigger forward, left trigger reverse, stick Y fallback | Left controller stick, then right | Right / left squeeze | Right secondary face button | Left secondary face button |

Analog sticks and the rendered-size touch joystick use a `0.14` deadzone.
Opposing keyboard or discrete-touch directions cancel. XR, keyboard, touch,
and gamepad input are mixed per axis in that priority order, and the HUD reports
the active source. Input is cleared when the browser loses focus. Compatible
gamepads receive dual-rumble feedback on resets, impacts, and boost release;
mobile browsers may use `navigator.vibrate()` for impacts. Optional steering
assist adds a gentle course-alignment correction without replacing player input.

### Invite your pit crew

The HUD **Invite** button opens a keyboard-accessible pit pass with:

- a QR code generated locally in the browser;
- the complete room URL and one-tap copy feedback;
- the device's native share sheet when available;
- encoded email, text-message, and WhatsApp links.

The QR library is loaded on demand from jsDelivr, but the room URL is encoded on
the device and is not sent to a QR image service. Invite URLs preserve the room,
course, lap rule, static-host subpath, relay, and unrelated query parameters.
Relay access still determines who can join a private heat.

### Driving, collisions, and feedback

Each handling class defines its own acceleration, reverse speed, drag, steering,
bounce, ride height, and pivot-turn behavior. Sampled course surfaces preserve
speed and grip on asphalt and its shoulder, while off-road terrain reduces
acceleration, steering, and maximum speed. The route HUD reports lap, sector,
course progress, airborne state, and wrong-way or off-course driving.

Vehicle footprints are measured from their rendered geometry. Rotated
rectangle collision tests separate overlapping local, parked, and remote
vehicles only when their vertical ranges overlap, then apply damped knockback.
Barriers, tire walls, trees, rocks, containers, poles, cones, parked scenery,
and paddock supports register static collision bodies. Safety-boundary or stuck
states recover to the most recent aligned road pose instead of trapping the car
against an invisible edge.

Ramp zones apply vertical velocity and gravity to ground vehicles, with reduced
airborne steering and landing impacts. Plane and helicopter classes expose
controlled altitude; low aircraft can hit tall scenery while sufficiently high
aircraft clear ground vehicles and props. Ground vehicles produce dust and skid
effects, high throttle produces exhaust smoke, and the helicopter produces
rotor wash. Sustained on-course drifting
fills the boost meter; straightening the vehicle releases the earned charge as
a short acceleration and top-speed burst with camera, audio, particle, skid,
and haptic feedback.

In solo play, **Pause** stops race time, vehicles, and effects. Its accessible
race-control sheet can resume, restart the full countdown, toggle steering
assist, or return to the lobby. Online heats keep running for every peer, so
pause is disabled there. **Reset** only recovers the active vehicle and
invalidates its current checkpoint chain; it does not erase completed laps.

Music, sound effects, and their saved preferences are generated entirely with
the Web Audio API. The interface also honors `prefers-reduced-motion`.

## XR runtimes

| Mode | Runtime | Placement | Notes |
| --- | --- | --- | --- |
| Desktop/mobile 3D | Local Three.js renderer | Automatic | WebGL fallback and non-AR play |
| Native WebXR | Browser `immersive-ar` session | Hit-test reticle or automatic fallback | Requires a secure origin and browser/device support |
| 8th Wall | On-demand XR8 camera pipeline | Camera-runtime origin | Loads only after explicit selection |

### Native WebXR

XRRC requests:

- required `local-floor` reference space;
- optional `hit-test`, `dom-overlay`, and `hand-tracking`;
- a DOM overlay rooted at the game UI.

When hit testing is available, tap the reticle or use an XR controller select
action to place the course. If the browser grants the session without hit-test
support, the course is placed 2.7 meters in front of the viewer. The enlarged AR
course scales inversely to `COURSE_SCALE` so a placed course stays roughly five
metres across. Enlarging the circuits therefore cannot quietly inflate the AR
footprint past the room someone is standing in, and the browser tests assert the
product of the two scales rather than either one alone.

### 8th Wall

8th Wall's hosted platform retired on 28 February 2026, so there is no
`apps.8thwall.com/xrweb?appKey=...` script and no app key to configure. The
engine is the freely distributed npm binary instead, pinned to an exact version
rather than a floating major range - a silent bump to a closed-source binary
would otherwise break camera AR in production with nothing in the repo changing.

iOS Safari has no WebXR, so camera mode is the only AR route on iPhone and iPad.
The lobby detects this: `navigator.xr.isSessionSupported('immersive-ar')` gates
the WebXR button, and camera mode is offered independently.

Selecting 8th Wall loads the pinned engine binary, XRExtras, and landing-page
packages from jsDelivr, then registers:

- GL texture rendering;
- Three.js scene integration;
- XR controller support;
- landing, loading, full-window canvas, and runtime-error modules;
- the XRRC start/update pipeline.

`XR8.run()` resolves once the pipeline has the canvas, not once the camera feed
is live, and a pipeline that fails to start never rejects it. Camera mode
therefore waits on its own `onStart` callback with a timeout, so a stalled or
refused start reports an error and re-enables the button instead of leaving the
lobby on "Loading camera mode..." forever. Desktop browsers are told camera mode
needs a phone rather than being dropped into the engine's full-screen
"continue on your phone" landing page, which has no way back.

The engine binary is subject to the
[Niantic Spatial XR Engine License](https://github.com/8thwall/engine/blob/main/LICENSE);
the companion packages retain their respective licenses.

### Quest quality profile

Quest Browser/Meta Quest user agents select this profile automatically. Use
`?quality=quest` to exercise it elsewhere.

| Setting | Standard | Quest |
| --- | ---: | ---: |
| Device pixel ratio | Up to 2 | 1 |
| Antialiasing | On | Off |
| Dynamic shadows | On | Off |
| Particle pool | 180 | 96 |
| XR framebuffer scale | 1.0 | 0.85 |
| XR foveation | 0 | 0.65 |

The runtime and controller contracts are covered with browser mocks. Final
72/90 Hz thermal and frame-pacing confirmation still requires physical Quest
hardware.

## Private multiplayer

XRRC uses the Node service for discovery only:

```text
GitHub Pages browser -- WSS --> Tailscale Serve --> 127.0.0.1:3000
         peer A <========== unordered WebRTC data channel ==========> peer B
         peer A <============ ordered race channel =================> peer B
```

1. Browsers connect to `/ws?room=<room>&track=<track>` and receive a random peer ID.
2. The signaling service relays validated `offer`, `answer`, and `ice` messages
   only within the normalized room and course.
3. Peers exchange game state directly over an unordered, zero-retransmit WebRTC
   data channel.
4. The active vehicle sends sequenced state every 50 ms. Receivers reject
   malformed or stale sequences, predict at most 120 ms ahead, and interpolate
   toward the result.
5. Lap count, checkpoints, finish state, and results also use a reliable ordered
   companion channel. Race attempts and revisions prevent late unordered
   snapshots from rolling back newer milestones.
6. The first browser in a room owns the lap rule; later peers accept rules only
   from that host. If it leaves, authority migrates to the longest-connected
   remaining peer.
7. The WebSocket client reconnects with bounded exponential backoff. The server
   removes empty rooms and checks connections with a 30-second heartbeat.

Google STUN servers are configured, but no TURN relay is bundled. Networks that
cannot establish a direct WebRTC path need an external TURN configuration.
Rooms have no persistence or application-level authentication.

### Run signaling through Tailscale Serve

Start the service on its intentionally local-only default bind:

```bash
ALLOWED_ORIGINS=https://lab.liambroza.com \
HOST=127.0.0.1 \
PORT=3000 \
npm start

tailscale serve --bg 3000
tailscale serve status
```

Test the private endpoint from another device on the tailnet:

```bash
curl https://your-device.your-tailnet.ts.net/health
```

Enter `https://your-device.your-tailnet.ts.net` in the lobby relay field, or
share a configured URL:

```text
https://lab.liambroza.com/XRRC/?room=friday-night&track=harbor&signal=https%3A%2F%2Fyour-device.your-tailnet.ts.net
```

The client converts HTTPS to WSS, appends `/ws` when no path is supplied, and
adds the normalized room. Every browser in the heat must be able to reach the
same tailnet device. The origin allowlist is a browser-origin control, not user
authentication; keep Tailscale access restricted and avoid `ALLOWED_ORIGINS=*`.

### Signaling service safeguards

- Binds to `127.0.0.1` unless `HOST` is explicitly changed.
- Allows `https://lab.liambroza.com` and local browser origins by default.
- Applies the same origin policy to WebSocket upgrades and `/health`.
- Limits WebSocket payloads to 256 KiB.
- Relays only WebRTC offer, answer, and ICE message types.
- Normalizes room codes to lowercase URL-safe names of at most 32 characters and
  isolates each room by normalized course ID.
- Exposes connection and room counts through a non-cacheable health response.

## Deployment and configuration

### GitHub Pages

`.github/workflows/pages.yml` deploys `public/` on every push to `main`. Enable
**Settings > Pages > Build and deployment > GitHub Actions** for the repository.
All local asset references are relative, so the app works from the `/XRRC/`
repository subpath without a build step.

Static Pages deployments run solo unless a signaling URL is supplied. To
preconfigure the private relay, create the Actions repository variable
`XRRC_SIGNAL_URL`:

```bash
gh variable set XRRC_SIGNAL_URL \
  --body "https://your-device.your-tailnet.ts.net"
```

The Pages workflow writes that value into `public/runtime-config.js` before
uploading the static artifact. A `signal` query parameter overrides deployment
configuration; `signal=off` or `signal=solo` explicitly disables multiplayer.

For another static host, publish `public/` and set its runtime configuration:

```js
window.XRRC_DEPLOYMENT = Object.freeze({
  siteUrl: 'https://example.com/xrrc/',
  signalUrl: 'https://your-device.your-tailnet.ts.net',
});
```

Update the canonical and Open Graph URLs in `public/index.html` when changing
the public site.

### Environment and deployment values

| Name | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `HOST` | `127.0.0.1` | `server.js` | HTTP and WebSocket bind address |
| `PORT` | `3000` | `server.js` | HTTP and WebSocket port |
| `ALLOWED_ORIGINS` | `https://lab.liambroza.com` | `server.js` | Comma-separated browser origin allowlist |
| `XRRC_SIGNAL_URL` | Empty | Pages workflow | Build-time default relay URL |
| `XRRC_DEPLOYMENT.signalUrl` | Empty | Browser | Static runtime default relay URL |

### URL parameters

| Parameter | Example | Effect |
| --- | --- | --- |
| `room` | `friday-night` | Selects a normalized multiplayer room |
| `signal` | `https://device.tailnet.ts.net` | Overrides the relay; `off` and `solo` disable it |
| `track` | `harbor` | Preselects one of the six circuit IDs |
| `vehicle` | `tank` | Preselects any procedural type or GLB skin ID |
| `laps` | `3` | Selects a one-, three-, or five-lap lobby rule; values are clamped to 1-9 |
| `rivals` | `5` | Selects 0, 3, or 5 solo AI rivals |
| `assist` | `off` | Disables the saved steering-assist preference |
| `lang` | `es` | Selects `en`, `es`, or `fr` |
| `quality` | `quest` | Forces the reduced-cost Quest profile |
| `controls` | `touch` | Forces the touch UI for testing |
| `mode` | `desktop` | Starts desktop mode automatically |
| `demo` | `drive` | Autopilots the car around the circuit for captures |
| `view` | `overview` | Frames the whole circuit instead of chasing the car |

Valid vehicle IDs are `rally`, `buggy`, `truck`, `motorcycle`, `tank`, `plane`,
`helicopter`, `toy-car-1`, `toy-car-2`, `toy-car-3`, `toy-car-taxi`,
`toy-car-cop`, and `car1`.

## Performance

Repeated road markers, curbs, start tiles, barriers, tires, lane markings, and
trees use `THREE.InstancedMesh` with static instance matrices. The particle
system uses one points geometry and updates typed arrays instead of creating
per-effect meshes.

The original batching pass reduced the 1440 x 900 procedural rally reference
from **363 to 74 draw calls** at **16,222 rendered triangles**. On the enlarged
circuits a three-rival competition scene measures **69-82 draw calls** and
**78-80 geometries** across the six courses, rising to about **16,700
triangles** when the overview camera puts the whole lap in frustum. Rival
bodies use a single
low-poly mesh each, skid marks are instanced and attached only while needed, and
the ghost is non-colliding. Browser tests enforce the render budget for every
procedural vehicle class. GLB skin complexity depends on the selected asset.

The in-race bay uses a separate 128 x 128 offscreen renderer. Thumbnails are
generated one at a time during idle windows so model parsing cannot delay the
first rendered frame or multiplayer handshake. Each result is cached as a data
URL and its temporary vehicle geometry is disposed.

Inspect the current frame from DevTools:

```js
window.XRRC_DIAGNOSTICS.snapshot()
```

The snapshot reports draw calls, triangles, points, geometries, textures,
object count, particle capacity, pixel ratio, XR scale, antialiasing, quality,
vehicle types, rivals, standings, race timing, ghost and boost state, road
normals, and shadow state.

## Architecture

| Path | Responsibility |
| --- | --- |
| `public/index.html` | Accessible lobby, runtime controls, HUD, and CDN imports |
| `public/css/style.css` | Responsive visual system, touch layout, and reduced-motion behavior |
| `public/js/game.js` | Three.js scene, track, vehicles, effects, XR integration, and UI orchestration |
| `public/js/game-core.js` | Deterministic handling, surfaces, vertical dynamics, vehicle specs, network validation, and prediction |
| `public/js/race-core.js` | Race formatting, standings, record persistence, and ghost interpolation |
| `public/js/controls.js` | Keyboard, pointer joystick, gamepad polling, and haptics |
| `public/js/controls-core.js` | Deadzones and device-independent control mappings |
| `public/js/network.js` | WebSocket signaling client plus unordered state and ordered race WebRTC channels |
| `public/js/config.js` | Room, relay, health, and invite URL normalization |
| `public/js/share-core.js` | Email, text, and WhatsApp invite target encoding |
| `public/js/xr-core.js` | Native WebXR session and 8th Wall runtime contracts |
| `public/js/audio.js` | Procedural music, engine, skid, cue, and impact audio |
| `public/js/i18n.js` | English, Spanish, and French dictionaries and persistence |
| `public/runtime-config.js` | Static-host deployment values |
| `server.js` | Static local host, signaling relay, origin policy, and health endpoint |
| `test/` | Node unit and integration tests |
| `e2e/` | Playwright gameplay, mobile, XR, performance, and WebRTC tests |
| `scripts/capture-screenshots.js` | Deterministic desktop, mobile, vehicle, and two-peer captures |

The frontend has no bundler or compile step. Browser-safe core modules expose
small globals and also export through CommonJS so Node can test deterministic
logic without a DOM.

## Contributor workflow

Install exact dependencies and the Chromium browser used by Playwright:

```bash
npm ci
npx playwright install chromium
```

| Command | Purpose |
| --- | --- |
| `npm start` | Start the static app and signaling service |
| `npm run check:syntax` | Parse-check the server and browser JavaScript |
| `npm test` | Run 65 Node tests |
| `npm run check` | Run syntax checks and Node tests |
| `npm run test:e2e` | Run 35 Chromium browser tests |
| `npm run test:e2e:update` | Update Playwright snapshots if added later |
| `npm run screenshots` | Replace the deterministic gallery captures |

CI uses Node.js 22, installs Chromium with system dependencies, runs
`npm run check`, and then runs `npm run test:e2e`.

### Test coverage

- vehicle physics, road/off-road handling, airborne arcs, landing, bounds,
  recovery, prediction, and sequence rejection;
- keyboard, gamepad, XInput, genuine touch, and Quest-style controller mappings;
- room and relay URL normalization;
- invite message encoding, accessible dialog structure, lazy QR rendering,
  clipboard/native share actions, direct share links, and mobile layout;
- origin-restricted health and signaling behavior plus room isolation;
- relative static assets, accessibility fallbacks, and Pages configuration;
- native WebXR and complete 8th Wall pipeline contracts;
- all seven procedural vehicle classes and render budgets;
- mobile localization, persisted language, calibrated touch controls, and
  discrete touch alternatives;
- start-grid alignment, route progress, static collisions, off-road slowdown,
  height-aware vehicle contact, ramp landing, and aircraft altitude;
- one-, three-, and five-lap rules, sectors, timing, AI standings, results,
  personal-best persistence and ghost replay, drift boost, pause, retry, and
  steering assist;
- real three-browser WebRTC vehicle exchange, reliable race milestones, stale
  revision rejection, and migrating host-owned lap-rule synchronization.

### Known limits and remaining verification

- Quest controller/session contracts and the reduced-cost profile are automated,
  but sustained 72/90 Hz frame pacing, thermals, comfort, and haptics still need
  confirmation on physical Quest hardware.
- Multiplayer remains private-room peer-to-peer play. TURN, room persistence,
  user authentication, public matchmaking, and global leaderboards are not
  bundled.
- Weapons, track editing, weather, progression, and voice chat remain future
  expansion scope rather than release blockers.
- The production URL updates only after this branch merges and the GitHub Pages
  workflow publishes `public/`; the deployed `/XRRC/` route and cache should be
  checked after that workflow completes.

### Adding a vehicle

For a new handling class:

1. Add its immutable spec to `VEHICLE_SPECS` in `public/js/game-core.js`.
2. Add a procedural builder and dispatch entry in `Vehicle.setType()`.
3. Add the lobby option and localization keys.
4. Extend unit, browser, and screenshot coverage.

For a rally-physics GLB skin:

1. Add the asset under `public/assets/cars/`.
2. Add its ID and relative path to `GLB_SKINS`.
3. Add the matching lobby option and localization keys.
4. Verify loading fallback, thumbnail framing, selection deep links, disposal,
   and two-peer synchronization.

Keep deterministic logic in a core module when possible, preserve relative
asset URLs for GitHub Pages, and update both the runtime config and static tests
when changing the canonical deployment.
