#!/usr/bin/env python3
"""librarian-ansible-extractor — the Ansible implementation of the Extractor
seam (issue #37, ADR-2 multi-language path; ADR-7 plugin protocol).

Ansible is YAML + Jinja2 + directory conventions, so this is a *convention-
aware* extractor, not a generic YAML one: it knows what playbooks, roles,
tasks, handlers and variable files look like. The parser is PyYAML only —
ansible-core's own loader would be closer to the official implementation but
drags the full ansible dependency into every indexing environment; the
convention knowledge needed here is small and stable (recorded in dlog).
`--capabilities` announces the parser flavor; a missing PyYAML degrades to
module-only output with a stderr warning instead of failing the index.

Routing (the shared #37/#39 decision): this extractor is NOT a built-in.
Ansible YAML has no self-declaration (unlike k8s apiVersion+kind), so a repo
opts in via `.librarian/extractors.json`, which overrides the k8s built-in
for `.yml`/`.yaml` (ADR-7 explicit registration; see README).

Contract is the same SCIP+ envelope as every other leg:

    stdin:  {"root": "/abs/repo", "files": ["/abs/repo/site.yml", ...]}
    stdout: {"scip": <scip.Index, proto3 canonical JSON>, "ext": {...}}

Symbols are reference addresses; the file itself is always a module symbol:

    play.Deploy taskflow api      (kind resource — plays declare state)
    task.Deploy app config        (kind function — named tasks only)
    handler.Restart api           (kind function)
    var.api_port                  (kind variable — top-level keys of
                                   defaults/vars/group_vars/host_vars files)
    role.taskflow_api             (kind module, anchored at
                                   roles/<r>/tasks/main.yml — like tf module
                                   blocks, told apart from the file symbol by
                                   the moniker)

Edges:
  - plays' `roles:` / `include_role` / `import_role` → role symbols; roles
    not in the repo (Galaxy) stay resolved=0 with the raw name — the future
    requirements.yml → repo declaration entry point (#35).
  - `notify` → handler.<name>.
  - `include_tasks` / `import_tasks` / `import_playbook` → the target file's
    module symbol (imports; same-extractor claimed set).
  - `template:` src → resolved=0 with the repo-relative path, only when the
    file exists (.j2 is unclaimed; the dockerfile COPY-source precedent).
  - `{{ var }}`: the leading simple identifier resolves against defined vars;
    runtime builtins (item, ansible_*, hostvars, ...) emit nothing; other
    undefined identifiers stay resolved=0 var.<name> — dynamic Jinja2 is left
    honestly unresolved, never guessed (issue #37).
"""

import hashlib
import json
import os
import posixpath
import re
import sys

PROTOCOL_NAME = "librarian-scip-plus"
PROTOCOL_VERSION = 1
MONIKER_SCHEME = "librarian-ansible"
EXTENSIONS = [".yml", ".yaml"]

SIMPLE_IDENT = re.compile(r"^[A-Za-z0-9_+$-]+$")
JINJA_VAR = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)")
ROLE_PATH = re.compile(r"(?:^|/)roles/([^/]+)/(tasks|handlers|defaults|vars|meta|templates)/")
VARS_DIR = re.compile(r"(?:^|/)(group_vars|host_vars)(?:/|$)")

#: Jinja2 names that are runtime state, not repo-defined variables — matching
#: them would spam an unresolved edge on nearly every task.
BUILTIN_VARS = re.compile(
    r"^(item|ansible_[a-z0-9_]*|inventory_[a-z0-9_]*|hostvars|groups|group_names|"
    r"play_hosts|lookup|query|now|omit|role_path|playbook_dir|undef)$"
)

TASK_INCLUDE_KEYS = ("include_tasks", "import_tasks", "ansible.builtin.include_tasks",
                     "ansible.builtin.import_tasks")
ROLE_INCLUDE_KEYS = ("include_role", "import_role", "ansible.builtin.include_role",
                     "ansible.builtin.import_role")
TEMPLATE_KEYS = ("template", "ansible.builtin.template")


def symbol_id(file, container, name, kind):
    """must match src/protocol/extractor.ts symbolId: sha256(file::container::name::kind)[:20]"""
    material = "%s::%s::%s::%s" % (file, container or "", name, kind)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:20]


def module_id(rel):
    return symbol_id(rel, None, rel, "module")


def escape_ident(name):
    return name if SIMPLE_IDENT.match(name) else "`" + name.replace("`", "``") + "`"


def moniker(row):
    head = MONIKER_SCHEME + " . . . " + escape_ident(row["file"]) + "/"
    if row["kind"] == "module" and row["name"] == row["file"]:
        return head
    return head + escape_ident(row["name"]) + "."


def scip_kind(kind):
    return {
        "module": "File",
        "resource": "Object",
        "function": "Function",
        "variable": "Variable",
    }.get(kind)


# ---- YAML loading with line marks ----


def load_documents(text, rel):
    """Parse every --- document into (value, marks) where scalars/collections
    carry their 1-based start/end lines through a parallel node walk."""
    import yaml

    try:
        nodes = list(yaml.compose_all(text, Loader=yaml.SafeLoader))
    except yaml.YAMLError as err:
        sys.stderr.write("warn: %s: %s\n" % (rel, err))
        return []
    return [n for n in nodes if n is not None]


def node_span(node):
    start = node.start_mark.line + 1
    end = node.end_mark.line + 1
    if node.end_mark.column == 0 and end > start:
        end -= 1  # end_mark points at the line after block collections
    return start, max(start, end)


def is_map(node):
    import yaml
    return isinstance(node, yaml.MappingNode)


def is_seq(node):
    import yaml
    return isinstance(node, yaml.SequenceNode)


def is_scalar(node):
    import yaml
    return isinstance(node, yaml.ScalarNode)


def map_get(node, key):
    if not is_map(node):
        return None
    for k, v in node.value:
        if is_scalar(k) and k.value == key:
            return v
    return None


def map_items(node):
    if not is_map(node):
        return []
    return [(k.value, v) for k, v in node.value if is_scalar(k)]


def scalar_val(node):
    return node.value if node is not None and is_scalar(node) else None


def scalar_list(node):
    """A scalar or a sequence of scalars → list of strings."""
    if node is None:
        return []
    if is_scalar(node):
        return [node.value]
    if is_seq(node):
        return [item.value for item in node.value if is_scalar(item)]
    return []


def walk_scalars(node):
    if node is None:
        return
    if is_scalar(node):
        yield node
        return
    if is_seq(node):
        for item in node.value:
            yield from walk_scalars(item)
        return
    if is_map(node):
        for k, v in node.value:
            yield from walk_scalars(v)


# ---- extraction ----


class Extractor:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.results = {}       # rel -> {"symbols": [...], "edges": [...]}
        self.claimed = set()
        self.roles = {}         # role name -> symbol id
        self.handlers = {}      # handler name -> symbol id
        self.vars = {}          # var name -> symbol id
        self.deferred = []      # (rel, from_id, callable) edge emitters

    def rel(self, abs_path):
        return os.path.relpath(abs_path, self.root).replace(os.sep, "/")

    def add_symbol(self, rel, name, kind, start, end):
        sid = symbol_id(rel, None, name, kind)
        self.results[rel]["symbols"].append({
            "id": sid, "kind": kind, "name": name, "file": rel,
            "spanStart": start, "spanEnd": end,
        })
        return sid

    def add_edge(self, rel, from_id, to_id, to_name, kind):
        self.results[rel]["edges"].append({
            "fromId": from_id, "toId": to_id, "toName": to_name,
            "kind": kind, "resolved": to_id is not None,
        })

    # -- classification --

    def classify(self, rel, docs):
        """vars file / playbook / tasks file / handlers file."""
        if VARS_DIR.search(rel):
            return "vars"
        m = ROLE_PATH.search(rel)
        if m:
            section = m.group(2)
            if section in ("defaults", "vars"):
                return "vars"
            if section == "handlers":
                return "handlers"
            if section == "tasks":
                return "tasks"
            return "other"
        for doc in docs:
            if is_seq(doc):
                for item in doc.value:
                    if is_map(item) and map_get(item, "hosts") is not None:
                        return "playbook"
                    if is_map(item) and map_get(item, "import_playbook") is not None:
                        return "playbook"
        for doc in docs:
            if is_seq(doc) and any(is_map(i) for i in doc.value):
                return "tasks"
        return "other"

    # -- pass 1: symbols --

    def collect_file(self, rel, docs, kind):
        if kind == "vars":
            for doc in docs:
                for name, value in map_items(doc):
                    start, end = node_span(value)
                    key_line = start
                    sid = self.add_symbol(rel, "var." + name, "variable", key_line, end)
                    self.vars.setdefault(name, sid)
            return

        if kind == "handlers":
            for doc in docs:
                if not is_seq(doc):
                    continue
                for item in doc.value:
                    name = scalar_val(map_get(item, "name"))
                    if not name:
                        continue
                    start, end = node_span(item)
                    sid = self.add_symbol(rel, "handler." + name, "function", start, end)
                    self.handlers.setdefault(name, sid)
                    self.deferred.append((rel, sid, item))
            return

        if kind == "tasks":
            role = ROLE_PATH.search(rel)
            container_id = module_id(rel)
            if role and rel.endswith("/tasks/main.yml"):
                # the role anchor: where role execution starts
                total = self.results[rel]["symbols"][0]["spanEnd"]
                container_id = self.add_symbol(rel, "role." + role.group(1), "module", 1, total)
                self.roles.setdefault(role.group(1), container_id)
            for doc in docs:
                if not is_seq(doc):
                    continue
                for item in doc.value:
                    if not is_map(item):
                        continue
                    name = scalar_val(map_get(item, "name"))
                    from_id = container_id
                    if name:
                        start, end = node_span(item)
                        from_id = self.add_symbol(rel, "task." + name, "function", start, end)
                    self.deferred.append((rel, from_id, item))
            return

        if kind == "playbook":
            for doc in docs:
                if not is_seq(doc):
                    continue
                for item in doc.value:
                    if not is_map(item):
                        continue
                    if map_get(item, "hosts") is None:
                        # import_playbook entries and other non-play items
                        self.deferred.append((rel, module_id(rel), item))
                        continue
                    name = scalar_val(map_get(item, "name"))
                    start, end = node_span(item)
                    play_name = "play." + (name if name else "%s:%d" % (posixpath.basename(rel), start))
                    play_id = self.add_symbol(rel, play_name, "resource", start, end)
                    self.collect_play(rel, play_id, item)

    def collect_play(self, rel, play_id, play):
        # handlers declared inline in the play
        handlers = map_get(play, "handlers")
        if is_seq(handlers):
            for item in handlers.value:
                name = scalar_val(map_get(item, "name"))
                if not name:
                    continue
                start, end = node_span(item)
                sid = self.add_symbol(rel, "handler." + name, "function", start, end)
                self.handlers.setdefault(name, sid)
                self.deferred.append((rel, sid, item))
        for section in ("tasks", "pre_tasks", "post_tasks"):
            block = map_get(play, section)
            if not is_seq(block):
                continue
            for item in block.value:
                if not is_map(item):
                    continue
                name = scalar_val(map_get(item, "name"))
                from_id = play_id
                if name:
                    start, end = node_span(item)
                    from_id = self.add_symbol(rel, "task." + name, "function", start, end)
                self.deferred.append((rel, from_id, item))
        # the play itself carries roles:, vars: references — but its task and
        # handler sections already produced their own precise entries, so
        # prune them before the play-level scalar walk (no duplicate edges).
        import yaml
        pruned = yaml.MappingNode(play.tag, [
            (k, v) for k, v in play.value
            if not (is_scalar(k) and k.value in
                    ("tasks", "pre_tasks", "post_tasks", "handlers"))
        ], start_mark=play.start_mark, end_mark=play.end_mark)
        self.deferred.append((rel, play_id, pruned))

    # -- pass 2: edges --

    def emit_edges(self):
        for rel, from_id, node in self.deferred:
            self.entry_edges(rel, from_id, node)

    def role_edge(self, rel, from_id, name):
        if not name:
            return
        sid = self.roles.get(name)
        self.add_edge(rel, from_id, sid, "role." + name if sid else name, "references")

    def file_edge(self, rel, from_id, target):
        """include_tasks / import_playbook: resolve relative to the current
        file's directory (and a role's tasks/ dir) against the claimed set."""
        if not target or "{{" in target:
            return
        candidates = [posixpath.normpath(posixpath.join(posixpath.dirname(rel), target))]
        m = ROLE_PATH.search(rel)
        if m:
            role_root = rel[: m.end(1)]  # ".../roles/<name>"
            candidates.append(posixpath.normpath(posixpath.join(role_root, "tasks", target)))
        for cand in candidates:
            if cand in self.claimed:
                self.add_edge(rel, from_id, module_id(cand), target, "imports")
                return
        self.add_edge(rel, from_id, None, target, "imports")

    def entry_edges(self, rel, from_id, node):
        if not is_map(node):
            return
        for key, value in map_items(node):
            if key == "roles" and is_seq(value):
                for item in value.value:
                    if is_scalar(item):
                        self.role_edge(rel, from_id, item.value)
                    elif is_map(item):
                        self.role_edge(rel, from_id, scalar_val(map_get(item, "role")))
            elif key in ROLE_INCLUDE_KEYS:
                if is_scalar(value):
                    self.role_edge(rel, from_id, value.value)
                elif is_map(value):
                    self.role_edge(rel, from_id, scalar_val(map_get(value, "name")))
            elif key == "notify":
                for name in scalar_list(value):
                    sid = self.handlers.get(name)
                    self.add_edge(rel, from_id, sid,
                                  "handler." + name if sid else name, "references")
            elif key in TASK_INCLUDE_KEYS:
                target = value.value if is_scalar(value) else scalar_val(map_get(value, "file"))
                self.file_edge(rel, from_id, target)
            elif key == "import_playbook":
                self.file_edge(rel, from_id, scalar_val(value))
            elif key in TEMPLATE_KEYS and is_map(value):
                src = scalar_val(map_get(value, "src"))
                if src and "{{" not in src:
                    self.template_edge(rel, from_id, src)
        # Jinja2 variable references anywhere in the entry
        seen = set()
        for scalar in walk_scalars(node):
            if not isinstance(scalar.value, str) or "{{" not in scalar.value:
                continue
            for m in JINJA_VAR.finditer(scalar.value):
                name = m.group(1)
                if name in seen or BUILTIN_VARS.match(name):
                    continue
                seen.add(name)
                sid = self.vars.get(name)
                if sid == from_id:
                    continue
                self.add_edge(rel, from_id, sid, "var." + name, "references")

    def template_edge(self, rel, from_id, src):
        """template src lives in the role's templates/ (or next to the file);
        emitted resolved=0 with the repo path only when it exists (.j2 is
        unclaimed — the dockerfile COPY-source rule)."""
        m = ROLE_PATH.search(rel)
        candidates = []
        if m:
            role_root = rel[: m.end(1)]  # ".../roles/<name>"
            candidates.append(posixpath.normpath(posixpath.join(role_root, "templates", src)))
        candidates.append(posixpath.normpath(posixpath.join(posixpath.dirname(rel), "templates", src)))
        candidates.append(posixpath.normpath(posixpath.join(posixpath.dirname(rel), src)))
        for cand in candidates:
            if os.path.exists(os.path.join(self.root, cand.replace("/", os.sep))):
                self.add_edge(rel, from_id, None, cand, "references")
                return

    # -- driver --

    def run(self, files):
        rels = []
        sources = {}
        for f in files:
            abs_path = f if os.path.isabs(f) else os.path.join(self.root, f)
            rel = self.rel(abs_path)
            rels.append(rel)
            self.claimed.add(rel)
            try:
                with open(abs_path, "r", encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError as err:
                sys.stderr.write("warn: %s: %s\n" % (rel, err))
                text = ""
            sources[rel] = text
            lines = max(1, text.count("\n") + (0 if text.endswith("\n") else 1))
            self.results[rel] = {
                "symbols": [{
                    "id": module_id(rel), "kind": "module", "name": rel, "file": rel,
                    "spanStart": 1, "spanEnd": lines,
                }],
                "edges": [],
            }

        try:
            import yaml  # noqa: F401
        except ImportError:
            sys.stderr.write(
                "warn: PyYAML is not installed — Ansible files indexed at file level only "
                "(pip install pyyaml, then reindex)\n")
            return self.emit_envelope(rels)

        parsed = {}
        for rel in rels:
            parsed[rel] = load_documents(sources[rel], rel)

        # pass 1: symbols (role/handler/var tables must be repo-complete
        # before edges resolve)
        kinds = {rel: self.classify(rel, parsed[rel]) for rel in rels}
        order = {"vars": 0, "handlers": 1, "tasks": 2, "playbook": 3, "other": 4}
        for rel in sorted(rels, key=lambda r: (order[kinds[r]], r)):
            self.collect_file(rel, parsed[rel], kinds[rel])
        # pass 2: edges
        self.emit_edges()

        for rel in rels:
            bucket = self.results[rel]
            bucket["symbols"].sort(key=lambda s: (s["spanStart"], s["name"]))
            bucket["edges"] = dedupe_edges(bucket["edges"])
        return self.emit_envelope(rels)

    # -- SCIP+ emit --

    def emit_envelope(self, rels):
        scip_name = {}
        for rel in rels:
            for row in self.results[rel]["symbols"]:
                scip_name[row["id"]] = moniker(row)

        documents = []
        ext_docs = []
        for rel in sorted(rels):
            bucket = self.results[rel]
            occurrences = []
            symbols = []
            ext_edges = []
            for row in bucket["symbols"]:
                sym = scip_name[row["id"]]
                occurrences.append({
                    "symbol": sym,
                    "symbolRoles": 1,
                    "singleLineRange": {"line": row["spanStart"] - 1},
                    "multiLineEnclosingRange": {
                        "startLine": row["spanStart"] - 1, "endLine": row["spanEnd"],
                    },
                })
                symbols.append({
                    "symbol": sym, "displayName": row["name"], "kind": scip_kind(row["kind"]),
                })
            for edge in bucket["edges"]:
                to = scip_name.get(edge["toId"]) if edge["toId"] is not None else None
                ext_edges.append({
                    "from": scip_name[edge["fromId"]], "to": to, "toName": edge["toName"],
                    "kind": edge["kind"], "resolved": to is not None,
                })
            documents.append({
                "language": "yaml",
                "relativePath": rel,
                "positionEncoding": "UTF8CodeUnitOffsetFromLineStart",
                "occurrences": occurrences,
                "symbols": symbols,
            })
            ext_docs.append({"relativePath": rel, "symbols": [], "edges": ext_edges})

        return {
            "scip": {
                "metadata": {
                    "toolInfo": {"name": MONIKER_SCHEME, "version": "0.1.0"},
                    "projectRoot": "file://" + self.root.replace(os.sep, "/"),
                    "textDocumentEncoding": "UTF8",
                },
                "documents": documents,
            },
            "ext": {"version": 1, "documents": ext_docs},
        }


def dedupe_edges(edges):
    seen = set()
    out = []
    for e in edges:
        key = (e["fromId"], e["toId"], e["toName"], e["kind"])
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    out.sort(key=lambda e: (e["fromId"], e["kind"], e["toName"]))
    return out


def main(argv):
    if "--capabilities" in argv[1:]:
        json.dump({
            "protocol": PROTOCOL_NAME,
            "protocolVersion": PROTOCOL_VERSION,
            "name": MONIKER_SCHEME,
            "extensions": EXTENSIONS,
            "parser": "pyyaml",
        }, sys.stdout)
        return 0

    try:
        req = json.load(sys.stdin)
    except ValueError as err:
        sys.stderr.write("error: bad request json (want {root, files}): %s\n" % err)
        return 1
    if not isinstance(req, dict) or "root" not in req or "files" not in req:
        sys.stderr.write("error: bad request json (want {root, files})\n")
        return 1

    try:
        out = Extractor(str(req["root"])).run(list(req["files"]))
    except Exception as err:  # a plugin failure must be loud, never a silent empty index
        sys.stderr.write("error: %s\n" % err)
        return 1
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
