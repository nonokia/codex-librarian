# cross-repo fixture pair — Python (#35)

The non-TypeScript twin of `eval/fixtures/cross-repo`: a published library and
its consumer, this time in Python, proving the §8.1 import-binding convention
works in an index that contains **no TypeScript at all** (the whole point of
#35).

- `py-core/` — the library, the package **`taskcore`**. Declarations live in
  `taskcore/task.py` / `taskcore/store.py` and are re-exported from
  `taskcore/__init__.py` (the barrel, so a target is *not* found in the entry
  file alone).
- `py-app/` — the consumer. It imports `taskcore` by package name
  (`from taskcore import ...`); `taskcore` is deliberately **not** on the app's
  import path, so the Python extractor cannot resolve it and leaves those edges
  `resolved = 0` — exactly the state a real two-repo checkout is in. The app
  also imports the stdlib `uuid` (an *undeclared* package): its call sites are
  named `uuid#uuid4` and stay unresolved, the same way `node:crypto#randomUUID`
  does in the TS pair — naming is not resolving.

Indexed into one db they are two repos (#11). Their imports of each other stay
unresolved until `librarian link` is given the declaration in
[`links.json`](links.json), which says `taskcore` **is** the repo `pycore`. The
package specifier's subpath separator is `.` (Python), not `/` (TS/Go) or `\`
(PHP) — `librarian link` handles all three.

```bash
librarian index eval/fixtures/cross-repo-py/py-core --db /tmp/x.db --repo-name pycore
librarian index eval/fixtures/cross-repo-py/py-app  --db /tmp/x.db --repo-name pyapp
librarian link --db /tmp/x.db --map eval/fixtures/cross-repo-py/links.json
librarian eval eval/golden/cross-repo-py.json --db /tmp/x.db
```

What still stays unresolved by design: `_store.add(...)` is a method call —
binding it to `MemStore.add` in the other repo needs receiver-type resolution,
which is the extractor's job, not `link`'s. So `crpy-003` deliberately does
**not** expect `MemStore`.

Baseline (linked vs unlinked, same golden set): `docs/cross-repo-baseline.md`.
