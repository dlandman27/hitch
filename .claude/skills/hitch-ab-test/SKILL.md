---
name: hitch-ab-test
description: Measure whether a change made a React Native app faster, by playing the same Hitch scenario several times before and after the change and comparing the numbers that don't swing between plays. Use when asked "did this help", "is v2 faster than v1", "test this fix", or to compare two versions of a screen. Needs Hitch running and attached to the app.
---

# A/B test a change with Hitch

Dev builds vary a lot between plays of the *same* code: JS blocked time has swung 10–20× between identical plays (160ms vs 3,260ms). One run before and one after proves nothing. Play a fixed scenario several times on each side, keep the change under test as the only difference, and judge by the numbers that hold still.

## 1. Check Hitch is attached

Call `hitch_status`: it must say `state: live`, the right app and the app's project. If the hitch MCP tools aren't loaded in this session, call them over HTTP:

```bash
mcp(){ curl -s -m 300 localhost:7370/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":${2:-{\}}}}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.result?.content?.[0]?.text??JSON.stringify(j))})'; }
mcp hitch_status
```

## 2. Make the two sides differ in one thing only

- Run `git status` in the app repo first. Uncommitted work that isn't part of the test must be the **same on both sides**: keep it in both, or set it aside for both. Say which in the report.
- Don't switch branches between sides. Set the change aside with a path-scoped stash so nothing else moves:

  ```bash
  git stash push -m "hitch ab: <what>" -- <only the change's files>   # side A (before)
  git stash pop                                                       # side B (after)
  ```

- Never commit, push or reset in the app repo for a test unless asked.

## 3. Pick a scenario that exercises the change

Steps: `{"reload": true}`, `{"wait": N}` (seconds), `{"open_url": "myapp://screen"}` (simulator deep link).

- **Load cost** (a screen while it loads): `[{"reload": true}, {"wait": 15}]`, with nobody touching the simulator.
- **Scroll or interaction cost**: Hitch can't touch the screen. Use a long `wait`, ask the person to do the same gesture in every play, and say the result depends on that.
- Use a **new scenario name per experiment** (e.g. `feed first screen ab`). Hitch compares a run with the previous run of the same name, so side B is compared with side A automatically.

## 4. Play each side 3 times

```bash
mcp hitch_run_scenario '{"name":"feed first screen ab","steps":[{"reload":true},{"wait":15}],"times":3}'   # side A; saves the steps
# git stash pop, then wait ~2s for Metro to see the change
mcp hitch_run_scenario '{"name":"feed first screen ab","times":3}'                                         # side B; replays them
```

Each call reloads the app `times` times; tell the person not to use the simulator meanwhile. Results are medians, saved under `~/.hitch/runs/<scenario>/`.

## 5. Judge by the numbers that hold still

| Trust | Metric | Why |
|---|---|---|
| High | Component mounts; renders and mounts of one component (`ProductCard 88r/48m`, `Shimmer` mounts) | The same code mounts the same things; these move only when the change does |
| High | React render time, avoidable re-renders | Fairly stable; a 10%+ move is real |
| Medium | Screen load time, JS heap at the end | Move a little between plays |
| Low | JS blocked ms, freezes, worst freeze, dropped frames | Swing 2–20× between identical plays (dev tooling, module loading after a reload). Read the reported **range**; if A's and B's ranges overlap, it's noise |

Hitch's "Overall: better / worse / mixed" verdict weighs every metric equally, noisy ones included. Don't repeat it as the conclusion; say what the stable metrics show.

Per-component counts are in each saved run's detail (one play's worth, not the median; the top 15 components by render time, so dropping out of the list is a signal, not proof it's gone):

```bash
cd ~/.hitch/runs/<scenario-slug> && for f in *.json; do node -e 'const r=require(process.argv[1]);console.log(process.argv[1].split("/").pop());for(const c of r.detail.renders.components)console.log(`  ${c.name} ${c.renders}r/${c.mounts}m ${c.ms}ms`)' "$PWD/$f"; done
```

## 6. Report

A table of before → after for the stable metrics, one line on the noisy ones with their ranges, what was kept the same on both sides, and a plain recommendation: keep it, it didn't do much, or it needs a scroll test. Leave the app repo as you found it plus the change, uncommitted.

To find *why* a number is what it is, use the `hitch-diagnose` skill.
