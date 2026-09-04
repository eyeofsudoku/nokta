# NOKTA

Grid territory game. Two or three players place dots on a lattice; dots of the
same colour auto-connect, and closing a loop claims the enclosed area.

Play: <https://eyeofsudoku.github.io/nokta/>

## Running locally

**ES modules do not run from `file://`.** Opening `index.html` directly will
fail with a CORS error on the `import` statements. Serve the directory instead:

```sh
python3 -m http.server 8000
```

then open <http://localhost:8000>.

## Tests

```sh
node test/invariants.test.js
```

DOM-free, no dependencies. Scans the whole board for illegal squares, mixed
outlines, open sides and ledger drift after every action, across full simulated games at each
AI difficulty for 2 and 3 players. Run it after any engine change.

## Layout

```
index.html        shell + UI/renderer/netcode (not yet extracted)
src/engine/       DOM-free game logic — constants, geometry, game, ai
src/render/       (empty — migration step 3)
src/net/          (empty — migration step 4)
src/ui/           (empty — migration step 4)
test/             engine invariant suite
```

`src/engine/` is DOM-free and imports nothing outside `src/engine/`, so it can
be loaded and tested without a browser.

## Deploying

No build step. Commit to `main`; GitHub Pages serves the repo root with
`index.html` as the entry point. Keep that file at the root — moving it breaks
the shared URL.

See `CLAUDE.md` for architecture and invariants, `MIGRATION_BRIEF.md` for the
plan of work.
