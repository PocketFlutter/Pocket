# Liquid Glass for PocketJS guests

`@pocket/liquid_glass` composes buttons, navigation, menus, and overlays from PocketJS primitives. The guest owns composition, input state, spring motion, and optical surface admission. An admitted surface uses the existing `GlassSurface` rendering path exported by `@pocket/ui` through the host.

## Use in a guest

Add `@pocket/liquid_glass` to the project's guest dependencies and compile the entry with the [Pocket Guest build](TOOLING_API.md#buildguest). This example mounts a controlled glass toggle in a shared group.

```tsx
import { createSignal } from "solid-js";
import {
  LiquidGlassButton,
  LiquidGlassGroup,
  LiquidGlassProvider,
} from "@pocket/liquid_glass";

export function GlassActions() {
  const [saved, setSaved] = createSignal(false);

  return (
    <LiquidGlassProvider qualityTier="balanced">
      <LiquidGlassGroup>
        <LiquidGlassButton
          label={saved() ? "Saved" : "Save"}
          selected={saved()}
          onPress={() => setSaved((value) => !value)}
        />
      </LiquidGlassGroup>
    </LiquidGlassProvider>
  );
}
```

To use the kit with the reusable `UiSkinProvider`, call `registerLiquidGlassSkin()` from `@pocket/liquid_glass/kit` before selecting the `"liquid-glass"` skin. The Showcase gallery, stress page, and skin selection are consumers in `demo/js`. See [JS API](JS_API.md) for the guest package map.

## Public entries

The [package manifest](../packages/pocket_liquid_glass/package.json) declares these entry points. The root re-exports each module. The linked declarations cover component props, callbacks, and return types.

| Subpath | Main exports |
| --- | --- |
| `./tokens` | Theme modes (`light`, `dark`, `amber-night`), named or hex accents, `resolveLiquidGlassPalette`, `resolveOpticalRecipe`, `concentricGlassRadius`, and `hexToArgb`. [Declarations](../packages/pocket_liquid_glass/src/tokens.ts) |
| `./motion` | `GLASS_SPRINGS`, `stepGlassSpring`, `quantizeOptical`, `createGlassSpring`, and `createImperativeSpring`. [Declarations](../packages/pocket_liquid_glass/src/motion.ts) |
| `./governor` | `TIER_GPU_BUDGET`, `TIER_OVERLAY_RESERVE`, `createLiquidGlassGovernor`, `createGlassFrameProfiler`, and admission lease and profiler types. [Declarations](../packages/pocket_liquid_glass/src/governor.ts) |
| `./surfaces` | `LiquidGlassProvider`, `useLiquidGlass`, `useInLiquidGlassGroup`, `LiquidGlassBackdrop`, `LiquidGlassSurface`, and `LiquidGlassGroup`. [Declarations](../packages/pocket_liquid_glass/src/surfaces.tsx) |
| `./controls` | Flex surface, button, icon button, switch, slider, segmented control, badge, checkbox, radio group, input, progress, stepper, page control, and activity indicator. [Declarations](../packages/pocket_liquid_glass/src/controls.tsx) |
| `./navigation` | App bar, toolbar, navigation bar, card, list tile, metric, empty state, accordion, virtual list, and FPS HUD. [Declarations](../packages/pocket_liquid_glass/src/navigation.tsx) |
| `./overlays` | `LiquidGlassAlert`, `LiquidGlassToast`, `LiquidGlassDialog`, and `LiquidGlassSheet`. [Declarations](../packages/pocket_liquid_glass/src/overlays.tsx) |
| `./menus` | Menu, menu button, context menu, popover, alert modal, `LiquidGlassMenuHandoff`, `normalizeMenuSections`, and `measureViewportRect`. [Declarations](../packages/pocket_liquid_glass/src/menus.tsx) |
| `./kit` | `liquidGlassSkinAdapter`, `registerLiquidGlassSkin`, and `resolveLiquidGlassSkinTokens`. [Declarations](../packages/pocket_liquid_glass/src/kit.tsx) |

## Rendering and frame budget

With no parent provider, the default theme is light with a blue accent, comfortable density, and reduced motion off. A provider creates an `ultra` governor unless a `qualityTier` or governor is supplied. If both are supplied, the provider applies the tier to that governor. Theme settings inherit from the parent when omitted.

`LiquidGlassSurface` defaults to rounded regular material and normal priority. Materials are `clear`, `regular`, `thick`, and `chrome`. A clear, high-priority pill is the default group surface. Nested glass surfaces use their vector tint treatments within the group. Reduced transparency and increased contrast also select the vector treatment.

`LiquidGlassSurface` accepts `opacity?: number | Accessor<number>` (default `1`, clamped to `0..1`, quantized to `0.01`). A host glass surface is a compositor node and ignores ancestor `View` opacity, so overlays and controls must crossfade glass through this prop. It is forwarded to `GlassSurface` `opacity` for the GPU path and to the vector fallback's own `View` otherwise; foreground children keep their own opacity. At `0` the surface releases its governor lease and the host draws no backdrop pass, so a persistent but invisible surface costs no GPU work and remounts no children when it fades back in.

```tsx
const lift = createGlassSpring(() => (pressed() ? 1 : 0), { preset: "tactile", quantizeStep: 0.01 });
<LiquidGlassSurface material="clear" shape="pill" opacity={lift} magnification={() => 1 + 0.18 * lift()} />
```

Switch, slider, segmented-control and page-control indicators keep one persistent glass surface and one opaque resting view and crossfade them with a spring (`0` = opaque pill, `1` = clear magnifying lens) instead of swapping nodes with `<Show>`.

`createLiquidGlassGovernor(options = {})` defaults to `ultra` and a sixteen-surface admission budget (`TIER_GPU_BUDGET`). The other tiers are `balanced` (eight), `performance` (three), and `vector` (zero). `maxGpuSurfaces` overrides the ultra budget. `TIER_OVERLAY_RESERVE` (`ultra` 4, `balanced` 2, `performance` 1, `vector` 0) adds slots that only `critical` leases may use; a budget of zero also disables the reserve. `acquireLease(priority = "normal")` returns a lease with a reactive `granted()` accessor and `release()` method. Admission sorts by priority (`critical`, `high`, `normal`, `low`); within one priority an already granted lease keeps its slot, then acquisition order breaks ties. Critical leases consume the overlay reserve before they can displace a lower-priority surface, so opening a menu, popover or alert does not turn the resting glass underneath into vector fills. A higher-priority acquisition can still displace a lower-priority granted surface once the reserve is exhausted; an equal-priority newcomer never displaces a granted peer.

Migration from the previous budgets: callers that relied on exactly eight ultra slots should pass `maxGpuSurfaces: 8`. The provider's default governor no longer pins `maxGpuSurfaces: 8`. Automatic adaptation defaults on and uses a 58 FPS threshold when frame samples are supplied. The target used by the profiler defaults to 60 FPS. `createGlassFrameProfiler` reuses the shared `@pocket/ui/fast` profiler with a 60 Hz target and 60-sample window by default; its readings measure guest work and frame cadence, not GPU presentation. Releasing a lease makes `granted()` false and admits the next eligible surface. `LiquidGlassFpsHud` displays caller-supplied profiler samples; it shows “No frame samples” until the caller records work via `governor.recordFrameSample(beginMs, endMs)`. The HUD does not measure its own callback as whole-frame work.

### Menus and overlays

`LiquidGlassMenu` interpolates the glass quad's logical rect and corner radius from the trigger anchor to the platter (`999 → 22`). It applies no `scaleX`/`scaleY` and no clip to the glass, so the shader's bevel and its 36-unit optical halo stay undistorted. Only the foreground rows are clipped by a rounded mask that follows the morphing quad; rows keep their final typography and position. The platter glass fades through `LiquidGlassSurface` `opacity`; `LiquidGlassContextMenu`, `LiquidGlassPopover`, `LiquidGlassAlertModal` and the `LiquidGlassMenuButton` trigger pill fade their glass the same way. The alert platter wrapper no longer clips its glass halo.

Submenu push and pop stagger row reveal: each row eases from a 10-unit vertical offset (downward on push, upward on pop) and transparent to its place over the `snappy` spring, with a 0.05 per-row delay capped at 0.4.

`handoffPointer?: () => LiquidGlassMenuHandoff | undefined` forwards a trigger's gesture into an open menu. `LiquidGlassMenuHandoff` is `{ x, y, active, release? }` in viewport coordinates. While `active` is `true` the menu highlights the row under the point. Supplying a new object with `active: false, release: true` selects the row under that point exactly once (a repeated identical object is ignored). `LiquidGlassMenuButton` sends that release from its pan end, so a single press, drag into the menu and release selects the item.

The governor controls admission to the optical path. Flutter uses its existing refraction shader where shader filters and shader loading succeed, with a frosted host treatment otherwise. Web Preview uses its existing glass renderer subject to browser and graphics support. WeChat Mini Program rendering and device behavior remain unverified for this package. The 60 FPS target is a benchmark setting. Sustained frame rates, visual fidelity, and touch behavior require acceptance on each target. See [Apple Glass rendering](APPLE_GLASS.md) for the underlying renderer and its scoped measurements.

## Migration provenance and validation

This integration ports the former `feat/liquid-glass` patch identified by commits `ae8a2f3` and `1dcc2ab` into PocketFlutter/Pocket. The source-first comparison used these files under the retained `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`:

| Retained source | Behavior referenced | Adaptation |
| --- | --- | --- |
| `mini_apps/pocketjs_uikit.js` | The JS recipe for lens displacement and optical primitive props. | Package-owned palette and surface recipes drive the existing PocketJS primitives. |
| `shaders/liquid_glass.frag` | Rounded-box and circular signed distance fields, bevel displacement, frosted sampling, and rim highlights. | The guest package uses the current SDK's host glass path. |
| `lib/render/pocket_ui_components.dart` | `PocketLiquidGlassSurface` offers opt-in glass and resolves a standard surface by default. | JS composes the UI and owns the opt-in behavior. The host consumes drawing operations and provides native rendering. |
| `test/pocket_38_components_screenshot_test.dart` | The screenshot scenario opens the 38-component gallery and checks the standard UI with opt-in glass. | Use gallery navigation and input-driven rendering as acceptance scenarios in the current Showcase. |

### Optics and motion follow-up (Liquid Glass optimization)

Retained source reviewed: this SDK's own `packages/pocket_flutter/shaders/liquid_glass.frag`, `editor/client/liquid-glass.js`, `editor/client/preview.js`, `packages/pocket_flutter/lib/src/pocket_surface.dart`, `packages/pocket_ui/src/mobile.tsx` (`GlassSurface`) and this package. The retained parent `pocketjs_flutter_demo` was not available in the cloud workspace for this change; no parent behavior was replaced.

| Gap (evidence) | Change |
| --- | --- |
| `GlassSurface` forced `opacity: 1` for `effect: "glass"`; compositor surfaces ignore parent `View` opacity, so menus popped in and out. | `opacity` is forwarded for both effects. The shader gains `uOpacity` (float uniform 30) applied to the shadow band and the silhouette blend. Flutter skips the backdrop pass at `0` and fades the frosted fallback; Web Preview sets the uniform and only snapshots a fully opaque resting field. |
| Menu platter used non-uniform `scaleX`/`scaleY` plus `overflow` around the glass. | Logical rect/radius morph, row-only rounded mask (above). |
| Ultra budget 8 and Web output LRU 8; a critical overlay evicted resting cards. | Budgets 16/8/3/0, critical overlay reserve, incumbency; Web retains 32 outputs within 12 Mi pixels (48 MiB RGBA). |
| Switch, slider, segmented and page-control indicators remounted between a white `View` and glass on press. | One persistent surface crossfaded by a spring. |
| `LiquidGlassMenuButton` pan end cleared the handoff without selecting. | Release handoff commits the hovered row. |
| Monochromatic bevel refraction, muted rim. | Opt-in materials only: per-channel dispersion along the bevel normal (two extra taps inside the bevel band), rim scale 0.34/0.46 → 0.52/0.64 (clear/regular), and a Fresnel lift from the bevel height. The legacy variant 0 path is unchanged. |

Validation: `demo/js/tests/liquid_glass_native.test.ts` drives the real native guest with pointer input. It asserts that the menu platter's glass opacity rises monotonically from below 0.5 to 1 while its quad height grows by more than 40 units, that resting glass keeps its leases while the menu is open, that a single press-drag-release from `Options` onto `Wallpaper` pushes the submenu and its rows slide into place, and that holding a switch fades one clear droplet from below 0.4 to above 0.8 opacity with magnification above 1.1 and releases it at rest. Against the pre-change guest the test fails at the crossfade assertion. `packages/pocket_ui/test/glass_surface.isolated.ts` checks in-place glass opacity updates and clamping, the package test checks the new admission rules, and the four Web Preview glass tests pass with the shader change. Not validated here: Flutter widget/golden tests and the Impeller shader compile (no Flutter SDK in that environment), device frame rates, and visual parity with the reference renderer. Container `smin` unions, progressive scroll-edge blur, an animated Siri edge glow, vector icon assets and gallery push/pop transitions are not implemented.

The migration includes package tests for JS behavior, a native Guest fixture for build and runtime coverage, Flutter bridge transport tests, and native scaffold fixture tests. Physical-device signing, extension installation, action delivery, and platform-specific screenshot or frame-rate acceptance require separate evidence. The optional system widget and activity bridge is documented in [Optional plugins](OPTIONAL_PLUGINS.md#native-surface-bridge).
