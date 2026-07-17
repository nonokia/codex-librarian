/**
 * K8sExtractor — the Kubernetes-manifest leg of the Extractor seam (issue #39,
 * ADR-2 multi-language path), a reference plugin of the subprocess protocol
 * (issue #22 / ADR-7), like the Terraform/SQL/Dockerfile legs.
 *
 * Extraction happens in `k8s-extractor/` (a small Go binary on yaml.v3).
 * Routing (the shared #37/#39 decision, recorded in dlog): this built-in
 * claims the generic `.yaml`/`.yml` extensions, and the k8s *content gate*
 * lives inside the plugin — documents self-declare via apiVersion + kind +
 * metadata.name, so non-k8s YAML degrades to its file module with zero false
 * edges. Ansible (#37) has no such self-declaration and stays opt-in via
 * `.librarian/extractors.json`, which overrides this built-in per repo.
 * Helm templates are not valid YAML and degrade to file level (v1 scope).
 *
 * Binary resolution order (build/distribution notes in README):
 *   1. $LIBRARIAN_K8S_EXTRACTOR — explicit path to a prebuilt binary
 *   2. `librarian-k8s-extractor` on $PATH (go install ./k8s-extractor)
 *   3. `go run <repo>/k8s-extractor` — dev fallback when a Go toolchain exists
 */
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SubprocessExtractor, type SubprocessCommand } from './subprocess.js';

function k8sExtractorSourceDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'k8s-extractor');
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export function resolveK8sExtractorCommand(): SubprocessCommand | null {
  const explicit = process.env.LIBRARIAN_K8S_EXTRACTOR;
  if (explicit) return { cmd: explicit, args: [] };
  const installed = onPath('librarian-k8s-extractor');
  if (installed) return { cmd: installed, args: [] };
  const src = k8sExtractorSourceDir();
  if (onPath('go') && existsSync(join(src, 'main.go'))) {
    return { cmd: 'go', args: ['run', '.'], cwd: src };
  }
  return null;
}

const UNAVAILABLE_WARNING =
  'warn: no k8s extractor available (set LIBRARIAN_K8S_EXTRACTOR, `go install ./k8s-extractor`, ' +
  'or install a Go toolchain) — .yaml/.yml files indexed at file level only. ' +
  'Reindex after installing (touch the files or delete the db) to get symbols/edges.';

export class K8sExtractor extends SubprocessExtractor {
  constructor() {
    super({
      name: 'librarian-k8s',
      extensions: ['.yaml', '.yml'],
      resolveCommand: resolveK8sExtractorCommand,
      unavailableWarning: UNAVAILABLE_WARNING,
    });
  }
}
