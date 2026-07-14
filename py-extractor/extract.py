#!/usr/bin/env python3
"""librarian py-extractor — the Python leg of the Extractor seam (issue #6,
ADR-2 multi-language path), a reference plugin of the subprocess protocol
(issue #22 / ADR-7).

librarian spawns `python3 extract.py` as a child process. Contract (SCIP+
envelope, issue #16 / docs/scip-design.md §4):

    stdin:  {"root": "/abs/repo", "files": ["/abs/repo/a.py", ...]}
    stdout: {"scip": <scip.Index, proto3 canonical JSON>, "ext": {...}}

The scip half is a standards-compliant SCIP index (hand-built JSON — no
protobuf dependency in Python, by design). The ext half carries what SCIP
cannot express: the edge taxonomy, unresolved references, and testblocks as
first-class symbols. Ingest (src/protocol/scip-ingest.ts) treats ext as the
source of truth for edges.

Parsing is the standard library's `ast` — CPython's own parser, so the grammar
is never a re-implementation (the reasoning that picked go/packages,
nikic/php-parser and hashicorp/hcl for the other legs). What the stdlib does
NOT give is type inference, and Python ships no stdlib type checker, so the
name story is built here:

  * module/import graph (absolute, relative and submodule imports)
  * per-module binding table: what each name in scope denotes
  * class hierarchy with in-repo MRO for member lookup, plus override edges
    (`MemStore.complete` --extends--> `Store.complete`), which is what lets a
    change to an implementation reach the contract's callers
  * a small type environment — `self`/`cls`, annotated parameters, annotated or
    constructed locals, annotated return types, container element types, and
    attribute types learned in `__init__` — which is what turns the everyday
    `self._store.complete(id)` into a real edge

Anything the environment cannot type — duck-typed receivers, `getattr`,
callables from third-party code — is kept with resolved=false and the name as
written. Completeness is sacrificed, measurability is not (the policy the TS,
Go and PHP extractors follow).

Parse fidelity is bounded by the interpreter running this script: a file whose
syntax is newer than that interpreter degrades to its file-level module symbol
(with a warning) instead of failing the run. Point $PYTHON_BINARY at a recent
python3 to index repos that use recent syntax.

Symbol ids reuse librarian's scheme — sha256(file::container::name::kind)
hex-truncated to 20 — so rows from every language coexist in one store.
"""

import ast
import hashlib
import json
import os
import re
import sys

MONIKER_SCHEME = "librarian-py"
PROTOCOL_NAME = "librarian-scip-plus"
PROTOCOL_VERSION = 1
EXTENSIONS = [".py", ".pyi"]

FUNC_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)
SIMPLE_IDENT = re.compile(r"^[A-Za-z0-9_+$-]+$")
TEST_FILE = re.compile(r"(^|/)(test_[^/]+|[^/]+_test)\.py$")
#: annotations that wrap an element type: `x: List[Task]` types `for t in x` as Task,
#: and `x` itself is NOT a Task. Dict is absent on purpose (iterating it yields keys).
CONTAINERS = ("List", "Sequence", "Iterable", "Iterator", "Set", "FrozenSet", "Tuple")
#: wrappers that leave the type scalar: `-> Optional[Task]` still returns a Task
SCALAR_WRAPPERS = ("Optional",)


def symbol_id(file, container, name, kind):
    """must match src/protocol/extractor.ts symbolId: sha256(file::container::name::kind)[:20]"""
    material = "%s::%s::%s::%s" % (file, container or "", name, kind)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:20]


# ---- SCIP+ emit helpers (issue #16, docs/scip-design.md §4.2) ----


def escape_ident(name):
    return name if SIMPLE_IDENT.match(name) else "`" + name.replace("`", "``") + "`"


def descriptor_for(name, kind):
    if kind in ("function", "method"):
        return escape_ident(name) + "()."
    if kind == "class":
        return escape_ident(name) + "#"
    return escape_ident(name) + "."  # variable


def moniker(row):
    """file as namespace descriptor, container chain (always classes in Python
    → '#'), then self. The package part stays empty — monikers never carry the
    repo dimension."""
    head = MONIKER_SCHEME + " . . . " + escape_ident(row["file"]) + "/"
    if row["kind"] == "module":
        return head
    if row["container"]:
        for seg in row["container"].split("."):
            head += escape_ident(seg) + "#"
    return head + descriptor_for(row["name"], row["kind"])


def scip_kind(kind):
    """SymbolInformation.Kind enum name, or None for testblock (ext is its truth)."""
    return {
        "module": "File",
        "function": "Function",
        "method": "Method",
        "class": "Class",
        "variable": "Variable",
    }.get(kind)


# ---- AST helpers ----


def span_of(node):
    """1-based inclusive line span. Decorators are part of the span (a diff that
    touches a decorator must seed the decorated symbol). end_lineno exists only
    on 3.8+, so fall back to the deepest line in the subtree."""
    start = node.lineno
    for dec in getattr(node, "decorator_list", []):
        start = min(start, dec.lineno)
    end = getattr(node, "end_lineno", None)
    if end is None:
        end = max([getattr(n, "lineno", start) for n in ast.walk(node)] + [start])
    return start, max(end, start)


def dotted(node):
    """Source-level dotted name of a Name/Attribute chain, else None."""
    parts = []
    cur = node
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if not isinstance(cur, ast.Name):
        return None
    parts.append(cur.id)
    return ".".join(reversed(parts))


def annotation_type(node):
    """(type name, is_container) for an annotation, or (None, False).

    Best effort by design: an annotation this cannot read yields no type rather
    than a guess, because a wrong type here becomes a false edge. `List[Task]`
    reads as ("Task", True) — the element type — which is what types the loop
    variable in `for t in tasks`."""
    if node is None:
        return (None, False)
    if isinstance(node, ast.Name):
        return (node.id, False)
    if isinstance(node, ast.Attribute):
        return (dotted(node), False)
    if isinstance(node, ast.Subscript):
        wrapper = (dotted(node.value) or "").split(".")[-1]
        if wrapper not in CONTAINERS and wrapper not in SCALAR_WRAPPERS:
            return (None, False)
        sl = node.slice
        if isinstance(sl, ast.Index):  # <3.9
            sl = sl.value
        if isinstance(sl, ast.Tuple):
            sl = sl.elts[0] if sl.elts else None
        name, _ = annotation_type(sl)
        return (name, wrapper in CONTAINERS)
    if isinstance(node, ast.Str):  # forward reference, <3.8
        return (node.s.strip() or None, False)
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return (node.value.strip() or None, False)
    return (None, False)


def annotation_name(node):
    return annotation_type(node)[0]


def render_annotation(node):
    """Annotation source text, rendered here rather than with `ast.unparse` so a
    symbol's signature is the same row on every interpreter (unparse only exists
    on 3.9+, and its spelling varies) — signatures are stored rows, and the store
    must not depend on which python3 ran the extractor."""
    if node is None:
        return None
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return dotted(node) or (render_annotation(node.value) + "." + node.attr)
    if isinstance(node, ast.Subscript):
        sl = node.slice
        if isinstance(sl, ast.Index):  # <3.9
            sl = sl.value
        return "%s[%s]" % (render_annotation(node.value), render_annotation(sl))
    if isinstance(node, ast.Tuple):
        return ", ".join(render_annotation(e) for e in node.elts)
    if isinstance(node, ast.List):
        return "[%s]" % ", ".join(render_annotation(e) for e in node.elts)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):  # X | Y, 3.10+
        return "%s | %s" % (render_annotation(node.left), render_annotation(node.right))
    if isinstance(node, ast.Constant):  # 3.8+: None, True, "ForwardRef", ...
        return node.value if isinstance(node.value, str) else repr(node.value)
    if isinstance(node, ast.Str):  # <3.8 forward reference
        return node.s
    if isinstance(node, ast.NameConstant):  # <3.8 None/True/False
        return repr(node.value)
    if isinstance(node, ast.Ellipsis):
        return "..."
    return "..."  # anything else renders as a placeholder, never as nothing


def _arg_text(arg):
    ann = render_annotation(arg.annotation)
    return arg.arg + (": " + ann if ann else "")


def signature_of(node):
    """`def create_task(self, title: str) -> Task` — names + annotations, no body."""
    a = node.args
    posonly = list(getattr(a, "posonlyargs", []))
    parts = [_arg_text(arg) for arg in posonly + list(a.args)]
    if posonly:
        parts.insert(len(posonly), "/")
    if a.vararg is not None:
        parts.append("*" + _arg_text(a.vararg))
    elif a.kwonlyargs:
        parts.append("*")
    parts.extend(_arg_text(arg) for arg in a.kwonlyargs)
    if a.kwarg is not None:
        parts.append("**" + _arg_text(a.kwarg))
    prefix = "async def " if isinstance(node, ast.AsyncFunctionDef) else "def "
    text = prefix + node.name + "(" + ", ".join(parts) + ")"
    ret = render_annotation(node.returns)
    return text + (" -> " + ret if ret else "")


def docstring_of(node):
    try:
        doc = ast.get_docstring(node, clean=True)
    except Exception:
        return None
    return (doc or "").strip() or None


def is_test_file(rel):
    return bool(TEST_FILE.search(rel)) or "/tests/" in "/" + rel


def self_attr(target):
    """`self.store` → "store"; anything else → None."""
    if isinstance(target, ast.Attribute) and dotted(target.value) == "self":
        return target.attr
    return None


def target_names(target):
    """Assignment target(s) → bound names (tuple unpacking included)."""
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        out = []
        for elt in target.elts:
            out.extend(target_names(elt))
        return out
    return []


def dedupe_edges(edges):
    seen = set()
    out = []
    for e in edges:
        key = (e["fromId"], e["toId"] or "", e["toName"], e["kind"])
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    return out


class Extractor:
    def __init__(self, root):
        self.root = root
        self.results = {}          # rel → {file, symbols, edges}
        self.asts = {}             # rel → Module
        self.module_of = {}        # rel → dotted module path
        self.file_of_module = {}   # dotted module path → rel
        self.sym_ids = {}          # rel → set of emitted ids (dedupe)
        self.syms_in = {}          # rel → [(id, start, end)] for innermost-enclosing lookups
        self.tb_parent = {}        # testblock id → owning class id (SCIP enclosingSymbol)

        # the name story
        self.top = {}              # modpath → {name: entry} (module-level bindings)
        self.classes = {}          # class fqn → decl record
        self.class_at = {}         # (rel, lineno) → class fqn
        self.returns = {}          # symbol id → (annotation name, is_container)
        self.bindings = {}         # rel → {local name: entry}

    # ---- paths & modules ----

    def rel(self, abs_path):
        return os.path.relpath(abs_path, self.root).replace(os.sep, "/")

    def modpath(self, rel):
        """pkg/mod.py → pkg.mod, pkg/__init__.py → pkg."""
        path = re.sub(r"\.pyi?$", "", rel)
        parts = [p for p in path.split("/") if p]
        if parts and parts[-1] == "__init__":
            parts.pop()
        return ".".join(parts)

    def is_package(self, rel):
        return rel.endswith("__init__.py") or rel.endswith("__init__.pyi")

    def resolve_module(self, name):
        """dotted module path → claimed file, or None. Exact match first, then a
        unique suffix match — which is what makes src/ layouts and installed-
        package imports resolve. An ambiguous suffix stays unresolved rather
        than guessing."""
        if not name:
            return None
        hit = self.file_of_module.get(name)
        if hit is not None:
            return hit
        suffix = "." + name
        cands = [f for m, f in self.file_of_module.items() if m.endswith(suffix)]
        return cands[0] if len(cands) == 1 else None

    def module_id(self, rel):
        return symbol_id(rel, None, rel, "module")

    # ---- run: five passes, because resolution needs whole-project knowledge ----

    def run(self, files):
        for abs_path in files:
            if not os.path.isabs(abs_path):
                abs_path = os.path.join(self.root, abs_path)
            self.load(abs_path)

        for rel, tree in self.asts.items():
            self.collect_symbols(rel, tree)          # 1. declarations
        for rel, tree in self.asts.items():
            self.bindings[rel] = self.collect_bindings(rel, tree)  # 2. what names denote
        for fqn in list(self.classes):
            self.learn_attributes(fqn)               # 3. attribute types (needs 1+2)
        for rel, tree in self.asts.items():
            self.collect_edges(rel, tree)            # 4. edges
        for fqn in list(self.classes):
            self.override_edges(fqn)                 # 5. method overrides

        for rel in self.results:
            self.results[rel]["edges"] = dedupe_edges(self.results[rel]["edges"])
        return self.emit_envelope()

    def load(self, abs_path):
        rel = self.rel(abs_path)
        try:
            with open(abs_path, "r", encoding="utf-8") as fh:
                code = fh.read()
        except OSError as err:
            sys.stderr.write("warn: unreadable %s: %s\n" % (rel, err))
            code = ""
        lines = max(1, code.count("\n") + (0 if code.endswith("\n") or code == "" else 1))
        # every claimed file gets at least its file-level module symbol, so a file
        # that fails to parse still exists in the store and diff seeding can fall
        # back to it (degrade, don't block).
        self.results[rel] = {
            "file": rel,
            "symbols": [{
                "id": self.module_id(rel), "kind": "module", "name": rel, "file": rel,
                "container": None, "spanStart": 1, "spanEnd": lines,
                "signature": None, "doc": None, "nameLine": 1,
            }],
            "edges": [],
        }
        self.sym_ids[rel] = {self.module_id(rel)}
        self.syms_in[rel] = []
        mod = self.modpath(rel)
        self.module_of[rel] = mod
        self.file_of_module.setdefault(mod, rel)
        self.top.setdefault(mod, {})

        try:
            tree = ast.parse(code, filename=rel)
        except SyntaxError as err:
            sys.stderr.write(
                "warn: parse failed for %s (python %s): %s — indexed at file level only\n"
                % (rel, ".".join(str(v) for v in sys.version_info[:3]), err.msg)
            )
            return
        self.asts[rel] = tree
        self.results[rel]["symbols"][0]["doc"] = docstring_of(tree)

    # ---- pass 1: declarations ----

    def add_symbol(self, rel, kind, name, container, node, signature=None, doc=None):
        sid = symbol_id(rel, container, name, kind)
        if sid in self.sym_ids[rel]:
            return sid  # a redefinition of the same identity is one row
        start, end = span_of(node)
        self.sym_ids[rel].add(sid)
        self.results[rel]["symbols"].append({
            "id": sid, "kind": kind, "name": name, "file": rel, "container": container,
            "spanStart": start, "spanEnd": end, "signature": signature, "doc": doc,
            "nameLine": node.lineno,
        })
        self.syms_in[rel].append((sid, start, end))
        return sid

    def collect_symbols(self, rel, tree):
        self.walk_decls(rel, self.module_of[rel], tree.body, container=None, class_fqn=None)

    def walk_decls(self, rel, mod, body, container, class_fqn):
        """Declarations of one scope. A def nested inside a function is NOT a
        symbol: its calls attribute to the enclosing function (the innermost
        registered symbol), which keeps closures and decorator bodies out of the
        graph without losing their edges."""
        for node in body:
            if isinstance(node, ast.ClassDef):
                self.collect_class(rel, mod, node, container)
            elif isinstance(node, FUNC_NODES):
                self.collect_function(rel, mod, node, container, class_fqn)
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                self.collect_variables(rel, mod, node, container, class_fqn)

    def collect_class(self, rel, mod, node, container):
        inner = ".".join([p for p in (container, node.name) if p])
        fqn = "%s.%s" % (mod, inner) if mod else inner
        sid = self.add_symbol(rel, "class", node.name, container, node, doc=docstring_of(node))
        self.class_at[(rel, node.lineno)] = fqn
        self.classes[fqn] = {
            "file": rel,
            "name": node.name,
            "id": sid,
            "init": None,                                   # the __init__ node, for pass 3
            "bases": [dotted(b) for b in node.bases if dotted(b)],
            "methods": {},                                  # name → id
            "attrs": {},                                    # name → id (class-body only)
            "attr_ann": {},                                 # name → annotation name (class body)
            "attr_types": {},                               # name → class fqn (learned)
            "is_test": self.looks_like_test_class(rel, node),
        }
        if container is None:
            self.top[mod][node.name] = {"kind": "class", "id": sid, "file": rel, "fqn": fqn}
        self.walk_decls(rel, mod, node.body, container=inner, class_fqn=fqn)

    def looks_like_test_class(self, rel, node):
        """unittest: a TestCase subclass. pytest: a Test* class in a test file."""
        for base in node.bases:
            if (dotted(base) or "").split(".")[-1].endswith("TestCase"):
                return True
        return is_test_file(rel) and node.name.startswith("Test")

    def collect_function(self, rel, mod, node, container, class_fqn):
        if class_fqn is not None:
            cls = self.classes[class_fqn]
            kind = "testblock" if (cls["is_test"] and node.name.startswith("test")) else "method"
        else:
            kind = "testblock" if (is_test_file(rel) and node.name.startswith("test_")) \
                else "function"
        sid = self.add_symbol(rel, kind, node.name, container, node,
                              signature=signature_of(node), doc=docstring_of(node))
        self.returns[sid] = annotation_type(node.returns)
        if class_fqn is not None:
            cls = self.classes[class_fqn]
            cls["methods"][node.name] = sid
            if kind == "testblock":
                self.tb_parent[sid] = cls["id"]
            if node.name == "__init__":
                cls["init"] = node
        else:
            self.top[mod][node.name] = {
                "kind": kind, "id": sid, "file": rel,
                "fqn": "%s.%s" % (mod, node.name) if mod else node.name,
            }

    def collect_variables(self, rel, mod, node, container, class_fqn):
        """Module-level and class-level assignments become `variable` symbols:
        config constants and class fields are what a diff touches, and the type
        environment resolves reads of them. Locals inside functions are not
        symbols."""
        targets = [node.target] if isinstance(node, ast.AnnAssign) else node.targets
        ann = annotation_name(node.annotation) if isinstance(node, ast.AnnAssign) else None
        for target in targets:
            for name in target_names(target):
                sid = self.add_symbol(rel, "variable", name, container, node)
                if class_fqn is not None:
                    cls = self.classes[class_fqn]
                    cls["attrs"][name] = sid
                    if ann:
                        cls["attr_ann"][name] = ann
                else:
                    self.top[mod][name] = {
                        "kind": "variable", "id": sid, "file": rel,
                        "fqn": "%s.%s" % (mod, name) if mod else name,
                    }

    # ---- pass 2: bindings (what each module-level name denotes) ----

    def collect_bindings(self, rel, tree):
        """Per-module name → entry. Imports bind names from other modules;
        `import a.b` also binds the dotted form so `a.b.f()` resolves."""
        binds = dict(self.top.get(self.module_of[rel], {}))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    name = alias.asname or alias.name
                    binds[name] = {"kind": "module", "module": alias.name,
                                   "file": self.resolve_module(alias.name)}
                    if alias.asname is None and "." in alias.name:
                        head = alias.name.split(".")[0]
                        binds.setdefault(head, {"kind": "module", "module": head,
                                                "file": self.resolve_module(head)})
            elif isinstance(node, ast.ImportFrom):
                base = self.import_from_module(rel, node)
                for alias in node.names:
                    if alias.name == "*":
                        continue
                    entry = self.lookup_in_module(base, alias.name)
                    if entry is None:
                        sub = "%s.%s" % (base, alias.name) if base else alias.name
                        entry = {"kind": "module", "module": sub, "file": self.resolve_module(sub)}
                    binds[alias.asname or alias.name] = entry
        return binds

    def import_from_module(self, rel, node):
        """Absolute, or relative (`from . import x`, `from ..pkg import y`)."""
        if not node.level:
            return node.module or ""
        pkg = [p for p in self.module_of[rel].split(".") if p]
        base = pkg if self.is_package(rel) else pkg[:-1]   # the module's own package
        drop = node.level - 1                              # `..` climbs one more
        if drop:
            base = base[:max(0, len(base) - drop)]
        if node.module:
            base = base + node.module.split(".")
        return ".".join(base)

    def lookup_in_module(self, modpath, name):
        """A top-level name of an in-repo module (function/class/variable)."""
        file = self.resolve_module(modpath)
        if file is None:
            return None
        entry = self.top.get(self.module_of[file], {}).get(name)
        return dict(entry) if entry else None

    def lookup(self, rel, name):
        """A dotted source-level name → what it denotes, via the file's bindings.
        None when nothing in the repo backs it (stdlib, third-party, dynamic)."""
        parts = name.split(".")
        entry = self.bindings.get(rel, {}).get(parts[0])
        if entry is None:
            return None
        if len(parts) == 1:
            return entry
        if entry["kind"] == "module":
            for cut in range(len(parts), 1, -1):          # longest module prefix wins
                modname = ".".join(parts[:cut])
                if self.resolve_module(modname) is None:
                    continue
                rest = parts[cut:]
                if not rest:
                    return {"kind": "module", "module": modname,
                            "file": self.resolve_module(modname)}
                found = self.lookup_in_module(modname, rest[0])
                if found is None:
                    continue
                if len(rest) == 1:
                    return found
                if found["kind"] == "class" and len(rest) == 2:
                    return self.member_of_class(found["fqn"], rest[1])
            return None
        if entry["kind"] == "class" and len(parts) == 2:
            return self.member_of_class(entry["fqn"], parts[1])
        return None

    # ---- class hierarchy ----

    def class_fqn_of(self, rel, name):
        """A class-ish name as written in `rel` → an in-repo class fqn, or None."""
        if not name:
            return None
        entry = self.lookup(rel, name)
        return entry["fqn"] if entry and entry["kind"] == "class" else None

    def mro(self, fqn, seen=None):
        """In-repo linearization: the class, then its bases depth-first. Bases
        outside the repo (object, ABC, TestCase) simply stop the walk."""
        seen = set() if seen is None else seen
        if fqn is None or fqn in seen or fqn not in self.classes:
            return []
        seen.add(fqn)
        out = [fqn]
        cls = self.classes[fqn]
        for base in cls["bases"]:
            out.extend(self.mro(self.class_fqn_of(cls["file"], base), seen))
        return out

    def member_of_class(self, fqn, name):
        for cur in self.mro(fqn):
            cls = self.classes[cur]
            if name in cls["methods"]:
                return {"kind": "method", "id": cls["methods"][name], "file": cls["file"],
                        "fqn": "%s.%s" % (cur, name)}
            if name in cls["attrs"]:
                return {"kind": "variable", "id": cls["attrs"][name], "file": cls["file"],
                        "fqn": "%s.%s" % (cur, name)}
        return None

    def attr_type_of(self, fqn, attr):
        """Class fqn of `<instance of fqn>.attr`, or None."""
        for cur in self.mro(fqn):
            cls = self.classes[cur]
            if attr in cls["attr_types"]:
                return cls["attr_types"][attr]
            if attr in cls["attr_ann"]:
                return self.class_fqn_of(cls["file"], cls["attr_ann"][attr])
        return None

    # ---- pass 3: attribute types ----

    def learn_attributes(self, class_fqn):
        """`self._store = store` in `__init__(self, store: Store)` → the attribute's
        type. This is the link that carries `self._store.complete(id)` — an
        injected-interface call — into the graph."""
        cls = self.classes[class_fqn]
        init = cls["init"]
        if init is None:
            return
        env = {}
        args = init.args
        for arg in list(getattr(args, "posonlyargs", [])) + list(args.args) + list(args.kwonlyargs):
            self.bind_annotation(env, cls["file"], arg.arg, arg.annotation)
        env["self"] = (class_fqn, False)
        for node in ast.walk(init):
            if isinstance(node, ast.AnnAssign):
                attr = self_attr(node.target)
                fqn = self.class_fqn_of(cls["file"], annotation_name(node.annotation))
                if attr and fqn:
                    cls["attr_types"][attr] = fqn
            elif isinstance(node, ast.Assign):
                fqn, container = self.infer(cls["file"], env, node.value)
                if fqn is None or container:
                    continue
                for target in node.targets:
                    attr = self_attr(target)
                    if attr:
                        cls["attr_types"][attr] = fqn

    def bind_annotation(self, env, rel, name, annotation):
        ann, container = annotation_type(annotation)
        fqn = self.class_fqn_of(rel, ann)
        if fqn:
            env[name] = (fqn, container)

    def infer(self, rel, env, value):
        """(class fqn, is_container) an expression evaluates to. Only three shapes
        — a constructor call, an annotated callable's return, and a name already
        in the environment — because a wrong guess here becomes a false edge."""
        if isinstance(value, ast.Name):
            return env.get(value.id, (None, False))
        if isinstance(value, ast.Call):
            name = dotted(value.func)
            if name is None:
                return (None, False)
            target = self.resolve_callable(rel, name, env)
            if target is None:
                return (None, False)
            if target["kind"] == "class":
                return (target["fqn"], False)
            ann, container = self.returns.get(target["id"], (None, False))
            return (self.class_fqn_of(target["file"], ann), container)
        return (None, False)

    # ---- pass 4: edges ----

    def add_edge(self, rel, from_id, to_id, to_name, kind, ref_line=None):
        if to_id is not None and to_id == from_id:
            return  # self loops are noise
        self.results[rel]["edges"].append({
            "fromId": from_id, "toId": to_id, "toName": to_name, "kind": kind,
            "resolved": to_id is not None,
            "refLine": ref_line,  # internal: reference-occurrence line (emit strips it)
        })

    def enclosing(self, rel, line):
        """Innermost registered symbol containing `line`; the file module otherwise."""
        best = None
        for sid, start, end in self.syms_in[rel]:
            if start <= line <= end and (best is None or (end - start) < (best[2] - best[1])):
                best = (sid, start, end)
        return best[0] if best else self.module_id(rel)

    def collect_edges(self, rel, tree):
        mod_id = self.module_id(rel)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    file = self.resolve_module(alias.name)
                    to = self.module_id(file) if file else None
                    self.add_edge(rel, mod_id, to, alias.name, "imports", node.lineno)
            elif isinstance(node, ast.ImportFrom):
                base = self.import_from_module(rel, node)
                for alias in node.names:
                    full = "%s.%s" % (base, alias.name) if base else alias.name
                    entry = None if alias.name == "*" else self.lookup_in_module(base, alias.name)
                    file = entry["file"] if entry else (
                        self.resolve_module("%s.%s" % (base, alias.name) if base else alias.name)
                        or self.resolve_module(base)
                    )
                    to = self.module_id(file) if file else None
                    self.add_edge(rel, mod_id, to, full, "imports", node.lineno)
            elif isinstance(node, ast.ClassDef):
                self.base_edges(rel, node)
        self.scope_edges(rel, tree.body, env={}, class_fqn=None)

    def base_edges(self, rel, node):
        """`class MemStore(Sequence, Store)` → extends. A class nested in a
        function is not a symbol, so its bases attribute to the enclosing one."""
        fqn = self.class_at.get((rel, node.lineno))
        from_id = self.classes[fqn]["id"] if fqn else self.enclosing(rel, node.lineno)
        for base in node.bases:
            name = dotted(base)
            if name is None:
                continue
            base_fqn = self.class_fqn_of(rel, name)
            to = self.classes[base_fqn]["id"] if base_fqn else None
            self.add_edge(rel, from_id, to, name, "extends", base.lineno)

    def scope_edges(self, rel, body, env, class_fqn):
        """Statements of a class body or module body."""
        for stmt in body:
            if isinstance(stmt, ast.ClassDef):
                for dec in stmt.decorator_list:
                    self.expr_edges(rel, dec, env, self.enclosing(rel, stmt.lineno))
                self.scope_edges(rel, stmt.body, {}, self.class_at.get((rel, stmt.lineno)))
            elif isinstance(stmt, FUNC_NODES):
                self.function_edges(rel, stmt, class_fqn)
            else:
                self.stmt_edges(rel, stmt, env, self.enclosing(rel, stmt.lineno))

    def function_edges(self, rel, node, class_fqn):
        """One function/method body with its own type environment."""
        from_id = self.enclosing(rel, node.lineno)
        env = {}
        if class_fqn is not None:
            env["self"] = (class_fqn, False)
            env["cls"] = (class_fqn, False)
        args = node.args
        for arg in list(getattr(args, "posonlyargs", [])) + list(args.args) + \
                list(args.kwonlyargs) + [a for a in (args.vararg, args.kwarg) if a is not None]:
            self.bind_annotation(env, rel, arg.arg, arg.annotation)
            if arg.annotation is not None:
                self.type_reference(rel, from_id, annotation_name(arg.annotation),
                                    arg.annotation.lineno)
        if node.returns is not None:
            self.type_reference(rel, from_id, annotation_name(node.returns), node.returns.lineno)
        for default in list(args.defaults) + [d for d in args.kw_defaults if d is not None]:
            self.expr_edges(rel, default, env, from_id)
        for dec in node.decorator_list:
            self.expr_edges(rel, dec, env, from_id)
        for stmt in node.body:
            self.stmt_edges(rel, stmt, env, from_id)

    def stmt_edges(self, rel, stmt, env, from_id):
        """One statement inside a body. A nested def is not a symbol: its body is
        walked with the same `from_id`, so its edges land on the enclosing one."""
        if isinstance(stmt, FUNC_NODES):
            inner = dict(env)
            for arg in stmt.args.args:
                self.bind_annotation(inner, rel, arg.arg, arg.annotation)
            for node in stmt.body:
                self.stmt_edges(rel, node, inner, from_id)
            return
        if isinstance(stmt, ast.ClassDef):
            for node in stmt.body:
                self.stmt_edges(rel, node, dict(env), from_id)
            return
        if isinstance(stmt, (ast.Import, ast.ImportFrom)):
            return  # already emitted as imports edges

        # learn types before emitting this statement's edges, so `s = MemStore()`
        # types `s` for the calls in the very same statement and the next one.
        if isinstance(stmt, ast.AnnAssign):
            for name in target_names(stmt.target):
                self.bind_annotation(env, rel, name, stmt.annotation)
            self.type_reference(rel, from_id, annotation_name(stmt.annotation),
                                stmt.annotation.lineno)
        elif isinstance(stmt, ast.Assign):
            fqn, container = self.infer(rel, env, stmt.value)
            if fqn:
                for target in stmt.targets:
                    for name in target_names(target):
                        env[name] = (fqn, container)
        elif isinstance(stmt, (ast.For, ast.AsyncFor)):
            self.bind_iteration(rel, env, stmt.target, stmt.iter)
        elif isinstance(stmt, ast.With):
            for item in stmt.items:
                if item.optional_vars is not None:
                    fqn, container = self.infer(rel, env, item.context_expr)
                    for name in target_names(item.optional_vars):
                        if fqn:
                            env[name] = (fqn, container)

        for child in ast.iter_child_nodes(stmt):
            if isinstance(child, ast.stmt):
                self.stmt_edges(rel, child, env, from_id)
            elif isinstance(child, ast.excepthandler):
                for node in child.body:
                    self.stmt_edges(rel, node, env, from_id)
                self.expr_edges(rel, child.type, env, from_id)
            else:
                self.expr_edges(rel, child, env, from_id)

    def bind_iteration(self, rel, env, target, iterable):
        """`for task in self._store.all()` — a container-typed iterable types the
        loop variable with its element type."""
        fqn, container = self.infer(rel, env, iterable)
        if not fqn or not container:
            return
        for name in target_names(target):
            env[name] = (fqn, False)

    def expr_edges(self, rel, node, env, from_id):
        """Calls and name/attribute reads inside an expression. Comprehensions
        carry their own generators, so their loop variables are typed here."""
        if node is None:
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            env = dict(env)
            for gen in node.generators:
                self.bind_iteration(rel, env, gen.target, gen.iter)
        for child in ast.iter_child_nodes(node):
            self.expr_edges(rel, child, env, from_id)
        if isinstance(node, ast.Call):
            self.call_edge(rel, node, env, from_id)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            self.name_reference(rel, from_id, node)
        elif isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load):
            self.attribute_reference(rel, from_id, node, env)

    def call_edge(self, rel, call, env, from_id):
        name = dotted(call.func)
        if name is None:
            return  # a call on a subscript/lambda/call — nothing nameable to record
        target = self.resolve_callable(rel, name, env)
        self.add_edge(rel, from_id, target["id"] if target else None, name, "calls", call.lineno)

    def resolve_callable(self, rel, name, env):
        parts = name.split(".")
        if len(parts) == 1:
            if parts[0] in env:  # `cls(...)` in a classmethod, or an aliased class
                fqn = env[parts[0]][0]
                cls = self.classes.get(fqn)
                return {"kind": "class", "id": cls["id"], "file": cls["file"], "fqn": fqn} \
                    if cls else None
            entry = self.lookup(rel, name)
        else:
            receiver, attr = ".".join(parts[:-1]), parts[-1]
            fqn = self.receiver_type(rel, receiver, env)
            if fqn:
                member = self.member_of_class(fqn, attr)
                return member if member and member["kind"] in ("method", "testblock") else None
            entry = self.lookup(rel, name)
        if entry and entry["kind"] in ("function", "class", "method", "testblock"):
            return entry
        return None

    def receiver_type(self, rel, receiver, env):
        """Class fqn of a receiver expression: `self`, `store`, `self._store`."""
        parts = receiver.split(".")
        if parts[0] not in env:
            return None
        fqn, container = env[parts[0]]
        if container:
            return None  # a list of Tasks is not a Task
        for attr in parts[1:]:
            fqn = self.attr_type_of(fqn, attr) if fqn else None
        return fqn

    def name_reference(self, rel, from_id, node):
        entry = self.lookup(rel, node.id)
        if entry and entry["kind"] in ("class", "variable", "function", "testblock"):
            self.add_edge(rel, from_id, entry["id"], node.id, "references", node.lineno)

    def attribute_reference(self, rel, from_id, node, env):
        name = dotted(node)
        if name is None:
            return
        parts = name.split(".")
        fqn = self.receiver_type(rel, ".".join(parts[:-1]), env)
        if fqn:
            member = self.member_of_class(fqn, parts[-1])
            if member and member["kind"] == "variable":
                self.add_edge(rel, from_id, member["id"], name, "references", node.lineno)
            return
        entry = self.lookup(rel, name)
        if entry and entry["kind"] in ("class", "variable", "function"):
            self.add_edge(rel, from_id, entry["id"], name, "references", node.lineno)

    def type_reference(self, rel, from_id, name, line):
        fqn = self.class_fqn_of(rel, name)
        if fqn is not None:
            self.add_edge(rel, from_id, self.classes[fqn]["id"], name, "references", line)

    # ---- pass 5: overrides ----

    def override_edges(self, class_fqn):
        """`MemStore.complete` --extends--> `Store.complete`. Python has no
        `@Override`, so the override is the only static link between a contract
        and its implementation — without it a change to an implementation method
        cannot reach the callers that go through the interface (they call the
        contract's method, not this one). The `extends` kind is deliberate: this
        is the same method→method relation the SCIP degrade path reconstructs
        from `is_implementation` (docs/scip-baseline.md)."""
        cls = self.classes[class_fqn]
        ancestors = self.mro(class_fqn)[1:]
        for name, sid in cls["methods"].items():
            for ancestor in ancestors:
                parent = self.classes[ancestor]
                if name in parent["methods"]:
                    self.add_edge(cls["file"], sid, parent["methods"][name],
                                  "%s.%s" % (parent["name"], name), "extends")
                    break

    # ---- SCIP+ emit (issue #16, docs/scip-design.md §4) ----

    def emit_envelope(self):
        scip_name = {}
        file_of_id = {}
        for rel, bucket in self.results.items():
            local = 0
            for row in bucket["symbols"]:
                file_of_id[row["id"]] = rel
                if row["kind"] == "testblock":
                    scip_name[row["id"]] = "local %d" % local
                    local += 1
                else:
                    scip_name[row["id"]] = moniker(row)

        documents = []
        ext_docs = []
        for rel, bucket in self.results.items():
            occurrences = []
            symbols = []
            ext_symbols = []
            ext_edges = []

            for row in bucket["symbols"]:
                sym = scip_name[row["id"]]
                roles = 1  # Definition
                if row["kind"] == "testblock":
                    roles |= 32  # Test
                occurrences.append({
                    "symbol": sym,
                    "symbolRoles": roles,
                    # empty range at the definition line: the graph is line-granular
                    # and an empty range is legal SCIP.
                    "singleLineRange": {"line": row["nameLine"] - 1},
                    "multiLineEnclosingRange": {
                        "startLine": row["spanStart"] - 1, "endLine": row["spanEnd"],
                    },
                })

                info = {"symbol": sym, "displayName": row["name"]}
                kind_name = scip_kind(row["kind"])
                if kind_name is not None:
                    info["kind"] = kind_name
                if row["doc"] is not None:
                    info["documentation"] = [row["doc"]]
                if row["signature"] is not None:
                    info["signatureDocumentation"] = {"language": "python",
                                                      "text": row["signature"]}
                if row["kind"] == "testblock":
                    parent = self.tb_parent.get(row["id"])
                    if parent is not None and parent in scip_name:
                        info["enclosingSymbol"] = scip_name[parent]
                    ext_symbols.append({
                        "symbol": sym, "kind": row["kind"], "name": row["name"],
                        "container": row["container"],
                        "spanStart": row["spanStart"], "spanEnd": row["spanEnd"],
                    })
                relationships = [
                    {"symbol": scip_name[e["toId"]], "isImplementation": True}
                    for e in bucket["edges"]
                    if e["kind"] == "extends" and e["fromId"] == row["id"]
                    and e["toId"] is not None and e["toId"] in scip_name
                ]
                if relationships:
                    info["relationships"] = relationships
                symbols.append(info)

            # edges: all go to ext (the source of truth); resolved
            # calls/references/imports also project to base occurrences.
            for edge in bucket["edges"]:
                to = None
                if edge["toId"] is not None and edge["toId"] in scip_name:
                    candidate = scip_name[edge["toId"]]
                    if candidate.startswith("local ") and file_of_id.get(edge["toId"]) != rel:
                        sys.stderr.write(
                            "warn: %s: dropping cross-file edge into a test block\n" % rel)
                    else:
                        to = candidate
                ext_edges.append({
                    "from": scip_name[edge["fromId"]], "to": to, "toName": edge["toName"],
                    "kind": edge["kind"], "resolved": to is not None,
                })
                if to is None or edge["kind"] == "extends" or edge["refLine"] is None:
                    continue
                occ = {"symbol": to, "singleLineRange": {"line": edge["refLine"] - 1}}
                if edge["kind"] == "imports":
                    occ["symbolRoles"] = 2  # Import
                occurrences.append(occ)

            documents.append({
                "language": "python",
                "relativePath": rel,
                "positionEncoding": "UTF8CodeUnitOffsetFromLineStart",
                "occurrences": occurrences,
                "symbols": symbols,
            })
            ext_docs.append({"relativePath": rel, "symbols": ext_symbols, "edges": ext_edges})

        return {
            "scip": {
                "metadata": {
                    "toolInfo": {"name": MONIKER_SCHEME, "version": "0.1.0"},
                    "projectRoot": "file://" + self.root,
                    "textDocumentEncoding": "UTF8",
                },
                "documents": documents,
            },
            "ext": {"version": 1, "documents": ext_docs},
        }


# ---- entry point: {root, files} on stdin → SCIP+ envelope on stdout ----


def main(argv):
    # Plugin-protocol handshake (issue #22 / ADR-7): `--capabilities` prints one
    # JSON line, reads no stdin, exits 0. The runner queries this to negotiate the
    # SCIP+ envelope major version before extracting.
    if "--capabilities" in argv[1:]:
        json.dump({
            "protocol": PROTOCOL_NAME,
            "protocolVersion": PROTOCOL_VERSION,
            "name": MONIKER_SCHEME,
            "extensions": EXTENSIONS,
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
