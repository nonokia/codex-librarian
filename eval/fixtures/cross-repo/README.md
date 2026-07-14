# cross-repo fixture pair (#27)

Two repositories that depend on each other the way real ones do: a published
library and its consumer.

- `acme-core/` — the library, published as the package **`@acme/core`**.
  Declarations live in `src/task.ts` / `src/store.ts` and are re-exported from
  `src/index.ts` (the realistic shape: the entry file is a barrel, so a target
  is *not* found by looking in the entry file alone).
- `acme-app/` — the consumer. It imports `@acme/core` by package name; the
  package is deliberately **not** installed under `node_modules`, so the
  TypeScript extractor cannot resolve it and leaves those edges `resolved = 0` —
  exactly the state a real two-repo checkout is in.

Indexed into one db they are two repos (#11). Their imports of each other stay
unresolved until `librarian link` is given the declaration in
[`links.json`](links.json), which says `@acme/core` **is** the repo `acme-core`.

```bash
librarian index eval/fixtures/cross-repo/acme-core --db /tmp/x.db --repo-name acme-core
librarian index eval/fixtures/cross-repo/acme-app  --db /tmp/x.db --repo-name acme-app
librarian link --db /tmp/x.db --map eval/fixtures/cross-repo/links.json
librarian eval eval/golden/cross-repo.json --db /tmp/x.db
```

Baseline (linked vs unlinked, same golden set): `docs/cross-repo-baseline.md`.
