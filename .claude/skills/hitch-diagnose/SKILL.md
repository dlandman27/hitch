---
name: hitch-diagnose
description: Turn Hitch results (a live session, a saved run, or a comparison of two runs) into the cause in the app's code — which component or line, why it re-rendered, and what to change. Use after a Hitch run or A/B test when the numbers are in and the question is "why", or when asked to explain a freeze, a choppy load, or a render count. Needs Hitch's MCP tools or its saved runs in ~/.hitch.
---

# Diagnose Hitch results

Hitch records *what* happened; this skill finds *why*, in the app's code, and checks the theory before anyone writes a fix. The rule that matters most: **confirm the cause with a measurement before fixing it.** Twice in a row a plausible story ("the carousels churn on load", "the flag loading flips the card layout") turned out wrong once logged.

If the hitch MCP tools aren't loaded, call them over HTTP with the `mcp` helper from the `hitch-ab-test` skill.

## 1. Get the right data

| You have | Read it with |
|---|---|
| A live session | `hitch_findings kind=stall`, then `hitch_finding <id>` for the big ones; `hitch_renders seconds=30` after a reload |
| A saved run | `curl -s "localhost:7370/api/run?id=<slug>/<file>"`, or read `~/.hitch/runs/<slug>/<file>.json` (`summary` = medians, `detail` = one play: `stalls`, `renders`, `jank`, `console`, `requests`) |
| Two runs | `curl -s "localhost:7370/api/runs/compare?a=<id>&b=<id>"` |

A run's `detail` comes from one play. The worst play's freezes may not be in it; if the summary's range shows a big outlier, record again rather than guess.

## 2. Separate the noise

Not the app's problem in production; say so and move on:

- **Dev-only tooling:** Reactotron and its Redux middleware (`reactotron-redux`, `microdiff`), Redux Toolkit dev checks (`isPlainObject`, `deepFreeze…`, `identity`), React dev profiling, `react-devtools-core`. Hitch labels most of these `devOnly`.
- **`PressabilityDebugView`:** every `Pressable` renders one in dev builds, even with the inspector off. Its renders don't exist in production.
- **Module loading after a reload:** a freeze whose stack is `metroRequire` / `loadModuleImplementation` all the way down is the bundle starting, not a render, even if Hitch's title says "React render".
- **`hitch-probe.js` frames:** Hitch's own probe; never blame the app.
- **Absolute times:** dev builds inflate them. Rankings and counts are real; milliseconds are relative.

## 3. Read what React rendered, and why

`hitch_finding` and `hitch_renders` list components as `Name ×renders (N mounted)` with reasons. Compare renders with mounts first: `ProductCard ×88 (48 mounted)` means 40 re-renders on top of the mounts.

| Reason | What it means | Usual fix |
|---|---|---|
| `new props with equal values (x: equal object, onY: new function)` | Parent passes a fresh copy of the same data, or a new callback | Find who rebuilds it: `useMemo` / `useCallback` with the right deps, read changing values from a ref, return the previous array when contents match |
| `its parent re-rendered and passed equal props (not memoized)` | Child has no `memo` | `memo` it, if its props are stable |
| `its parent re-rendered` on a `memo` component | The parent's render reached it anyway: custom comparator returned false, a hook inside subscribes, or a deferred re-render | Check the comparator and the hooks inside |
| `props changed (variant: changed, …)` | Real change; often a layout switch as data arrives | Ask whether it could start in its final shape |
| `a store subscription changed (hook N)` | A selector returned a new value | Narrow the selector, or make it return a stable reference |
| `a context value changed` ×8 | A provider rebuilt its value object | `useMemo` the provider value, split the context |

Then look for **volume**: mounts far above what's on screen (48 cards mounted, 5 visible) is a list rendering too far ahead. Check the list's `drawDistance` / `windowSize` / `initialNumToRender` and how the library scales it (LegendList renders 1.5× `drawDistance` ahead at scroll 0).

## 4. Follow the trigger chain into the code

From the component with the most avoidable renders, walk *up*: which prop changed, which parent built it, which hook built that. Read the code at each step; quote `file:line`.

## 5. Confirm the theory with a temporary log

Before fixing, prove the chain with a log the app prints, read through Hitch:

```tsx
// HITCH-DEBUG (temporary)
const prev = useRef(null);
if (prev.current && prev.current.items !== content.items) {
  const sameEls = prev.current.items.every((x, i) => x === content.items[i]);
  console.log(`HITCH-DEBUG ${key} items:new sameEls=${sameEls}`);
}
prev.current = content;
```

Then `hitch_reload_app`, wait, and `hitch_logs search="HITCH-DEBUG"`. Hitch groups repeats by fingerprint (numbers become placeholders), so read the `×N` counts. Log state transitions (`loading -> data`, `loading -> null`), not values, so the groups stay readable. **Remove every HITCH-DEBUG line before committing** (`git diff | grep HITCH-DEBUG` must be empty).

If the log contradicts the theory, say so and change course. Don't fix the theory anyway.

## 6. Size it before fixing

Estimate what the fix can save from the data: a component's ms × the avoidable renders, or the mounts removed. A real but small cause (~10ms) is worth a note, not a PR. Rank what's left by size and by whether it happens on every load or only on an interaction.

## 7. Hand off

For each cause: what happens, the chain with `file:line`, the evidence (render counts and reasons, the log output), the proposed fix, and what the A/B test should show if it works. Measure the fix with the `hitch-ab-test` skill.
