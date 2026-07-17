// librarian-sql-extractor — the SQL implementation of the Extractor seam
// (issue #36, ADR-2 multi-language path; ADR-7 plugin protocol).
//
// Like Terraform (and unlike the Go/PHP legs) this is NOT a call graph: SQL
// declarations (CREATE TABLE / VIEW / FUNCTION / ...) and references (FROM /
// JOIN / FOREIGN KEY / EXECUTE FUNCTION) are lexically explicit, so a
// syntax-level parse is sufficient — ADR-2's "type resolution required" is a
// call-graph-language judgment that does not apply here (recorded in dlog).
// The parser is libpg_query (pganalyze/pg_query_go), the PostgreSQL server's
// own parser extracted as a library — the closest thing SQL has to an official
// implementation. One dialect (Postgres) for now; the dialect is announced in
// --capabilities, and files the parser rejects degrade to their file-level
// module symbol (missing over false edges, architecture §8 risk 2).
//
// Contract is identical to tf-extractor (SCIP+ envelope, issue #16 /
// docs/scip-design.md §4):
//
//	stdin:  {"root": "/abs/repo", "files": ["/abs/repo/schema.sql", ...]}
//	stdout: {"scip": <scip.Index, proto3 canonical JSON>, "ext": {...}}
//
// Symbols are reference addresses (edge resolution is a string lookup on the
// relation/routine name, two namespaces: relations and routines):
//
//	CREATE TABLE users                → table.users        (kind table)
//	CREATE VIEW active_tasks          → view.active_tasks  (kind view)
//	CREATE MATERIALIZED VIEW stats    → matview.stats      (kind matview)
//	CREATE FUNCTION complete_task()   → function.complete_task (kind function)
//	CREATE PROCEDURE archive()        → procedure.archive  (kind procedure)
//	CREATE TRIGGER audit ON tasks     → trigger.audit      (kind trigger)
//	CREATE INDEX idx ON tasks         → index.idx          (kind index)
//
// Non-public schemas keep their qualifier (auth.accounts → table.auth.accounts);
// lookups try the qualified name first, then the bare name. The file itself is
// a module symbol (name === file), the librarian per-file anchor. Migrations
// are not folded into a final schema: each file emits its own declarations and
// references; ALTER / DML statements reference their target relations from the
// defining symbol when it lives in the same file, else from the file module.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	pg_query "github.com/pganalyze/pg_query_go/v6"
	scippb "github.com/scip-code/scip/bindings/go/scip"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

type symbolRow struct {
	ID        string
	Kind      string
	Name      string
	File      string
	SpanStart int
	SpanEnd   int
}

type edgeRow struct {
	FromID   string
	ToID     *string
	ToName   string
	Kind     string
	Resolved bool
}

type result struct {
	File    string
	Symbols []symbolRow
	Edges   []edgeRow
}

type request struct {
	Root  string   `json:"root"`
	Files []string `json:"files"`
}

func symbolID(file, name, kind string) string {
	// container is always empty for SQL symbols.
	sum := sha256.Sum256([]byte(file + "::" + "" + "::" + name + "::" + kind))
	return hex.EncodeToString(sum[:])[:20]
}

func moduleID(file string) string { return symbolID(file, file, "module") }

// pendingRefs defers reference resolution to pass 2, once the repo-global
// name tables are complete (cross-file references need them).
type pendingRefs struct {
	fromID string
	file   string
	// relation names (normalized addresses, e.g. "users" / "auth.accounts")
	rels []string
	// routine names (functions/procedures), e.g. from EXECUTE FUNCTION
	routines []string
}

type extractor struct {
	root     string
	results  map[string]*result // rel path -> bucket
	relToID  map[string]string  // normalized relation name -> symbol id (repo-global)
	funcToID map[string]string  // normalized routine name -> symbol id (repo-global)
	relFile  map[string]string  // normalized relation name -> defining file
	pending  []pendingRefs
}

func (e *extractor) rel(abs string) string {
	r, err := filepath.Rel(e.root, abs)
	if err != nil {
		return filepath.ToSlash(abs)
	}
	return filepath.ToSlash(r)
}

func (e *extractor) addSymbol(file, name, kind string, start, end int) string {
	id := symbolID(file, name, kind)
	e.results[file].Symbols = append(e.results[file].Symbols, symbolRow{
		ID: id, Kind: kind, Name: name, File: file, SpanStart: start, SpanEnd: end,
	})
	return id
}

// normalizeRel maps a RangeVar to the normalized relation name used in
// addresses and lookups: "public" (and empty) schema drops the qualifier,
// anything else keeps it.
func normalizeRel(rv *pg_query.RangeVar) string {
	if rv == nil || rv.Relname == "" {
		return ""
	}
	if rv.Schemaname == "" || rv.Schemaname == "public" {
		return rv.Relname
	}
	return rv.Schemaname + "." + rv.Relname
}

// qualifiedName joins a pg_query name list (e.g. CreateFunctionStmt.Funcname)
// into a normalized dotted name, dropping a leading "public".
func qualifiedName(items []*pg_query.Node) string {
	parts := make([]string, 0, len(items))
	for _, n := range items {
		if s := n.GetString_(); s != nil {
			parts = append(parts, s.Sval)
		}
	}
	if len(parts) > 1 && parts[0] == "public" {
		parts = parts[1:]
	}
	return strings.Join(parts, ".")
}

// registerRel records a relation (table/view/matview) in the repo-global
// lookup, under both its normalized name and its bare last segment. A repeated
// name (e.g. the same table re-created across migration files) keeps the first
// — deterministic, and matches the tf-extractor precedent.
func (e *extractor) registerRel(name, file, id string) {
	if _, ok := e.relToID[name]; !ok {
		e.relToID[name] = id
		e.relFile[name] = file
	}
	if i := strings.LastIndex(name, "."); i >= 0 {
		bare := name[i+1:]
		if _, ok := e.relToID[bare]; !ok {
			e.relToID[bare] = id
			e.relFile[bare] = file
		}
	}
}

func (e *extractor) registerRoutine(name, id string) {
	if _, ok := e.funcToID[name]; !ok {
		e.funcToID[name] = id
	}
	if i := strings.LastIndex(name, "."); i >= 0 {
		bare := name[i+1:]
		if _, ok := e.funcToID[bare]; !ok {
			e.funcToID[bare] = id
		}
	}
}

// ---- statement handling (pass 1: symbols + deferred references) ----

// stmtSpan converts a RawStmt's byte range into 1-based line numbers, skipping
// the leading whitespace libpg_query includes from after the previous statement.
func stmtSpan(src []byte, raw *pg_query.RawStmt) (int, int) {
	start := int(raw.StmtLocation)
	if start < 0 {
		start = 0
	}
	for start < len(src) && (src[start] == ' ' || src[start] == '\t' || src[start] == '\n' || src[start] == '\r') {
		start++
	}
	end := int(raw.StmtLocation) + int(raw.StmtLen)
	if raw.StmtLen == 0 || end > len(src) {
		end = len(src)
	}
	startLine := 1 + strings.Count(string(src[:start]), "\n")
	endLine := 1 + strings.Count(string(src[:end]), "\n")
	if endLine < startLine {
		endLine = startLine
	}
	return startLine, endLine
}

// stmtText slices a RawStmt's original source text (for plpgsql re-parsing).
func stmtText(src []byte, raw *pg_query.RawStmt) string {
	start := int(raw.StmtLocation)
	if start < 0 {
		start = 0
	}
	end := start + int(raw.StmtLen)
	if raw.StmtLen == 0 || end > len(src) {
		end = len(src)
	}
	return string(src[start:end])
}

// collectRangeVars walks any parse subtree and collects every RangeVar in it.
// Iteration order is protoreflect-undefined; callers rely on the final
// dedupe+sort for determinism, never on collection order.
func collectRangeVars(msg proto.Message, out *[]*pg_query.RangeVar) {
	if rv, ok := msg.(*pg_query.RangeVar); ok {
		*out = append(*out, rv)
		return
	}
	m := msg.ProtoReflect()
	m.Range(func(fd protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		switch {
		case fd.IsList():
			if fd.Kind() == protoreflect.MessageKind {
				list := v.List()
				for i := 0; i < list.Len(); i++ {
					collectRangeVars(list.Get(i).Message().Interface(), out)
				}
			}
		case fd.IsMap():
			// no maps in the pg_query tree we care about
		case fd.Kind() == protoreflect.MessageKind:
			collectRangeVars(v.Message().Interface(), out)
		}
		return true
	})
}

func relNamesIn(msg proto.Message) []string {
	var rvs []*pg_query.RangeVar
	collectRangeVars(msg, &rvs)
	names := make([]string, 0, len(rvs))
	for _, rv := range rvs {
		if n := normalizeRel(rv); n != "" {
			names = append(names, n)
		}
	}
	return names
}

// dmlStmt returns the referenced-relation names for top-level statements that
// touch existing relations (DML / queries in migrations and seeds). Statement
// types that *define* something are handled explicitly elsewhere; everything
// unknown returns nil so a new node type never produces false edges.
func dmlStmt(node *pg_query.Node) []string {
	switch {
	case node.GetSelectStmt() != nil:
		return relNamesIn(node.GetSelectStmt())
	case node.GetInsertStmt() != nil:
		return relNamesIn(node.GetInsertStmt())
	case node.GetUpdateStmt() != nil:
		return relNamesIn(node.GetUpdateStmt())
	case node.GetDeleteStmt() != nil:
		return relNamesIn(node.GetDeleteStmt())
	case node.GetMergeStmt() != nil:
		return relNamesIn(node.GetMergeStmt())
	case node.GetTruncateStmt() != nil:
		return relNamesIn(node.GetTruncateStmt())
	case node.GetCopyStmt() != nil:
		return relNamesIn(node.GetCopyStmt())
	}
	return nil
}

// fkTargets collects FOREIGN KEY target relations from a CREATE TABLE's
// column and table constraints.
func fkTargets(create *pg_query.CreateStmt) []string {
	var out []string
	addConstraint := func(n *pg_query.Node) {
		c := n.GetConstraint()
		if c != nil && c.Contype == pg_query.ConstrType_CONSTR_FOREIGN && c.Pktable != nil {
			if name := normalizeRel(c.Pktable); name != "" {
				out = append(out, name)
			}
		}
	}
	for _, elt := range create.TableElts {
		if col := elt.GetColumnDef(); col != nil {
			for _, c := range col.Constraints {
				addConstraint(c)
			}
		} else {
			addConstraint(elt)
		}
	}
	for _, c := range create.Constraints {
		addConstraint(c)
	}
	return out
}

// functionBodyRels extracts relation references from a CREATE FUNCTION /
// PROCEDURE body, in three tiers of parseability:
//  1. BEGIN ATOMIC (sql_body) — already a parse tree, walk it directly.
//  2. LANGUAGE sql AS $$...$$ — re-parse the body string.
//  3. LANGUAGE plpgsql — ParsePlPgSqlToJSON, then best-effort re-parse each
//     embedded expression/query string; fragments that fail to parse are
//     dropped, not guessed (missing over false edges).
func functionBodyRels(fn *pg_query.CreateFunctionStmt, stmtText string) []string {
	if fn.SqlBody != nil {
		return relNamesIn(fn.SqlBody)
	}
	language, body := "", ""
	for _, opt := range fn.Options {
		def := opt.GetDefElem()
		if def == nil {
			continue
		}
		switch def.Defname {
		case "language":
			if s := def.Arg.GetString_(); s != nil {
				language = s.Sval
			}
		case "as":
			if list := def.Arg.GetList(); list != nil && len(list.Items) > 0 {
				if s := list.Items[0].GetString_(); s != nil {
					body = s.Sval
				}
			}
		}
	}
	switch language {
	case "sql":
		if parsed, err := pg_query.Parse(body); err == nil {
			var out []string
			for _, raw := range parsed.Stmts {
				out = append(out, relNamesIn(raw.Stmt)...)
			}
			return out
		}
	case "plpgsql":
		return plpgsqlBodyRels(stmtText)
	}
	return nil
}

// plpgsqlBodyRels walks the plpgsql parse JSON for embedded "query" strings
// (PLpgSQL_expr) and re-parses each as SQL. Bare expressions (e.g. `NEW.id`)
// fail to parse and are skipped — only real embedded statements survive.
// ParsePlPgSqlToJSON wants the full CREATE FUNCTION source, so the caller
// passes the statement's original text slice.
func plpgsqlBodyRels(stmtText string) []string {
	plJSON, err := pg_query.ParsePlPgSqlToJSON(stmtText)
	if err != nil {
		return nil
	}
	var tree any
	if err := json.Unmarshal([]byte(plJSON), &tree); err != nil {
		return nil
	}
	var out []string
	var walk func(any)
	walk = func(v any) {
		switch t := v.(type) {
		case map[string]any:
			for k, sub := range t {
				if k == "query" {
					if q, ok := sub.(string); ok {
						if parsed, err := pg_query.Parse(q); err == nil {
							for _, raw := range parsed.Stmts {
								out = append(out, relNamesIn(raw.Stmt)...)
							}
						}
						continue
					}
				}
				walk(sub)
			}
		case []any:
			for _, sub := range t {
				walk(sub)
			}
		}
	}
	walk(tree)
	return out
}

func (e *extractor) collectStatements(file string, src []byte, parsed *pg_query.ParseResult) {
	for _, raw := range parsed.Stmts {
		start, end := stmtSpan(src, raw)
		node := raw.Stmt
		switch {
		case node.GetCreateStmt() != nil:
			create := node.GetCreateStmt()
			name := normalizeRel(create.Relation)
			if name == "" {
				continue
			}
			id := e.addSymbol(file, "table."+name, "table", start, end)
			e.registerRel(name, file, id)
			if targets := fkTargets(create); len(targets) > 0 {
				e.pending = append(e.pending, pendingRefs{fromID: id, file: file, rels: targets})
			}

		case node.GetViewStmt() != nil:
			view := node.GetViewStmt()
			name := normalizeRel(view.View)
			if name == "" {
				continue
			}
			id := e.addSymbol(file, "view."+name, "view", start, end)
			e.registerRel(name, file, id)
			e.pending = append(e.pending, pendingRefs{fromID: id, file: file, rels: relNamesIn(view.Query)})

		case node.GetCreateTableAsStmt() != nil:
			ctas := node.GetCreateTableAsStmt()
			if ctas.Into == nil || ctas.Into.Rel == nil {
				continue
			}
			name := normalizeRel(ctas.Into.Rel)
			kind, prefix := "table", "table."
			if ctas.Objtype == pg_query.ObjectType_OBJECT_MATVIEW {
				kind, prefix = "matview", "matview."
			}
			id := e.addSymbol(file, prefix+name, kind, start, end)
			e.registerRel(name, file, id)
			e.pending = append(e.pending, pendingRefs{fromID: id, file: file, rels: relNamesIn(ctas.Query)})

		case node.GetCreateFunctionStmt() != nil:
			fn := node.GetCreateFunctionStmt()
			name := qualifiedName(fn.Funcname)
			if name == "" {
				continue
			}
			kind, prefix := "function", "function."
			if fn.IsProcedure {
				kind, prefix = "procedure", "procedure."
			}
			id := e.addSymbol(file, prefix+name, kind, start, end)
			e.registerRoutine(name, id)
			if rels := functionBodyRels(fn, stmtText(src, raw)); len(rels) > 0 {
				e.pending = append(e.pending, pendingRefs{fromID: id, file: file, rels: rels})
			}

		case node.GetCreateTrigStmt() != nil:
			trig := node.GetCreateTrigStmt()
			if trig.Trigname == "" {
				continue
			}
			id := e.addSymbol(file, "trigger."+trig.Trigname, "trigger", start, end)
			p := pendingRefs{fromID: id, file: file}
			if name := normalizeRel(trig.Relation); name != "" {
				p.rels = append(p.rels, name)
			}
			if fname := qualifiedName(trig.Funcname); fname != "" {
				p.routines = append(p.routines, fname)
			}
			e.pending = append(e.pending, p)

		case node.GetIndexStmt() != nil:
			idx := node.GetIndexStmt()
			if idx.Idxname == "" {
				continue
			}
			id := e.addSymbol(file, "index."+idx.Idxname, "index", start, end)
			if name := normalizeRel(idx.Relation); name != "" {
				e.pending = append(e.pending, pendingRefs{fromID: id, file: file, rels: []string{name}})
			}

		case node.GetAlterTableStmt() != nil:
			alter := node.GetAlterTableStmt()
			name := normalizeRel(alter.Relation)
			if name == "" {
				continue
			}
			// the ALTER references its target relation, plus any FK targets in
			// added constraints; the edge source is the target's own symbol when
			// it is defined in this same file, else the file module.
			refs := []string{name}
			for _, cmd := range alter.Cmds {
				if c := cmd.GetAlterTableCmd(); c != nil && c.Def != nil {
					if constraint := c.Def.GetConstraint(); constraint != nil &&
						constraint.Contype == pg_query.ConstrType_CONSTR_FOREIGN && constraint.Pktable != nil {
						if t := normalizeRel(constraint.Pktable); t != "" {
							refs = append(refs, t)
						}
					}
				}
			}
			e.pending = append(e.pending, pendingRefs{fromID: "", file: file, rels: refs})

		default:
			if rels := dmlStmt(node); len(rels) > 0 {
				e.pending = append(e.pending, pendingRefs{fromID: "", file: file, rels: rels})
			}
		}
	}
}

// ---- pass 2: edges ----

func (e *extractor) resolveFrom(p pendingRefs) string {
	if p.fromID != "" {
		return p.fromID
	}
	// module-level statement (ALTER / DML): prefer the local defining symbol of
	// the first referenced relation when it lives in this file, else the file
	// module symbol.
	if len(p.rels) > 0 {
		if e.relFile[p.rels[0]] == p.file {
			if id, ok := e.relToID[p.rels[0]]; ok {
				return id
			}
		}
	}
	return moduleID(p.file)
}

func (e *extractor) collectEdges() {
	for _, p := range e.pending {
		bucket := e.results[p.file]
		fromID := e.resolveFrom(p)
		for _, name := range p.rels {
			e.addEdge(bucket, fromID, name, e.relToID[name])
		}
		for _, name := range p.routines {
			e.addEdge(bucket, fromID, name, e.funcToID[name])
		}
	}
}

func (e *extractor) addEdge(bucket *result, fromID, toName, toID string) {
	if toID == fromID && toID != "" {
		return // self loops are noise (e.g. ALTER TABLE emitted from the table's own symbol)
	}
	if toID != "" {
		to := toID
		bucket.Edges = append(bucket.Edges, edgeRow{
			FromID: fromID, ToID: &to, ToName: toName, Kind: "references", Resolved: true,
		})
	} else {
		// relation/routine not declared in the indexed files (extension objects,
		// other repos) → unresolved, raw name kept (measurability over completeness).
		bucket.Edges = append(bucket.Edges, edgeRow{
			FromID: fromID, ToID: nil, ToName: toName, Kind: "references", Resolved: false,
		})
	}
}

func dedupeEdges(edges []edgeRow) []edgeRow {
	seen := map[string]bool{}
	out := edges[:0]
	for _, e := range edges {
		to := ""
		if e.ToID != nil {
			to = *e.ToID
		}
		key := e.FromID + "|" + to + "|" + e.ToName + "|" + e.Kind
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, e)
	}
	return out
}

// ---- SCIP+ emit (issue #16, docs/scip-design.md §4) ----

const monikerScheme = "librarian-sql"

func escapeIdent(name string) string {
	simple := name != ""
	for _, r := range name {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' ||
			r == '_' || r == '+' || r == '$' || r == '-') {
			simple = false
			break
		}
	}
	if simple {
		return name
	}
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

// moniker per docs/scip-design.md §4.2: file as namespace descriptor, then the
// symbol as a term descriptor; the file-module is the bare file head. The
// package part stays empty ('. . .') — monikers never carry the repo dimension.
func moniker(row symbolRow) string {
	head := monikerScheme + " . . . " + escapeIdent(row.File) + "/"
	if row.Kind == "module" && row.Name == row.File {
		return head
	}
	return head + escapeIdent(row.Name) + "."
}

// scipKind maps librarian kinds to SCIP SymbolInformation_Kind. Must stay the
// exact inverse of KIND_TO_SCIP on the TS side so the moniker/kind round-trip
// holds: module→File and function→Function are reused; the six SQL kinds take
// otherwise-unused SCIP kinds (issue #36).
func scipKind(kind string) scippb.SymbolInformation_Kind {
	switch kind {
	case "module":
		return scippb.SymbolInformation_File
	case "function":
		return scippb.SymbolInformation_Function
	case "table":
		return scippb.SymbolInformation_Type
	case "view":
		return scippb.SymbolInformation_Delegate
	case "matview":
		return scippb.SymbolInformation_Instance
	case "procedure":
		return scippb.SymbolInformation_Macro
	case "trigger":
		return scippb.SymbolInformation_Event
	case "index":
		return scippb.SymbolInformation_Key
	}
	return scippb.SymbolInformation_UnspecifiedKind
}

type extEdge struct {
	From     string  `json:"from"`
	To       *string `json:"to"`
	ToName   string  `json:"toName"`
	Kind     string  `json:"kind"`
	Resolved bool    `json:"resolved"`
}

type extDocument struct {
	RelativePath string     `json:"relativePath"`
	Symbols      []struct{} `json:"symbols"` // SQL has no document-local symbols
	Edges        []extEdge  `json:"edges"`
}

type extPayload struct {
	Version   int           `json:"version"`
	Documents []extDocument `json:"documents"`
}

func (e *extractor) emitEnvelope(files []string) error {
	scipName := map[string]string{} // symbol id -> moniker
	for _, f := range files {
		for i := range e.results[f].Symbols {
			row := e.results[f].Symbols[i]
			scipName[row.ID] = moniker(row)
		}
	}

	index := &scippb.Index{
		Metadata: &scippb.Metadata{
			ToolInfo:             &scippb.ToolInfo{Name: monikerScheme, Version: "0.1.0"},
			ProjectRoot:          "file://" + filepath.ToSlash(e.root),
			TextDocumentEncoding: scippb.TextEncoding_UTF8,
		},
	}
	extOut := extPayload{Version: 1, Documents: make([]extDocument, 0, len(files))}

	for _, f := range files {
		r := e.results[f]
		doc := &scippb.Document{
			Language:         "sql",
			RelativePath:     f,
			PositionEncoding: scippb.PositionEncoding_UTF8CodeUnitOffsetFromLineStart,
		}
		extDoc := extDocument{RelativePath: f, Symbols: []struct{}{}, Edges: []extEdge{}}

		for i := range r.Symbols {
			row := r.Symbols[i]
			sym := scipName[row.ID]
			doc.Occurrences = append(doc.Occurrences, &scippb.Occurrence{
				Symbol:      sym,
				SymbolRoles: int32(scippb.SymbolRole_Definition),
				TypedRange: &scippb.Occurrence_SingleLineRange{
					SingleLineRange: &scippb.SingleLineRange{Line: int32(row.SpanStart - 1)},
				},
				TypedEnclosingRange: &scippb.Occurrence_MultiLineEnclosingRange{
					MultiLineEnclosingRange: &scippb.MultiLineRange{
						StartLine: int32(row.SpanStart - 1),
						EndLine:   int32(row.SpanEnd),
					},
				},
			})
			doc.Symbols = append(doc.Symbols, &scippb.SymbolInformation{
				Symbol:      sym,
				Kind:        scipKind(row.Kind),
				DisplayName: row.Name,
			})
		}

		for _, edge := range r.Edges {
			from := scipName[edge.FromID]
			var to *string
			if edge.ToID != nil {
				if t, ok := scipName[*edge.ToID]; ok {
					to = &t
				}
			}
			extDoc.Edges = append(extDoc.Edges, extEdge{
				From: from, To: to, ToName: edge.ToName, Kind: edge.Kind, Resolved: to != nil,
			})
		}

		index.Documents = append(index.Documents, doc)
		extOut.Documents = append(extOut.Documents, extDoc)
	}

	scipJSON, err := protojson.Marshal(index)
	if err != nil {
		return fmt.Errorf("encoding scip index: %w", err)
	}
	envelope := struct {
		Scip json.RawMessage `json:"scip"`
		Ext  extPayload      `json:"ext"`
	}{scipJSON, extOut}
	return json.NewEncoder(os.Stdout).Encode(envelope)
}

func countLines(b []byte) int {
	n := 1 + strings.Count(string(b), "\n")
	if len(b) > 0 && b[len(b)-1] == '\n' {
		n--
	}
	if n < 1 {
		n = 1
	}
	return n
}

func run() error {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return fmt.Errorf("reading stdin: %w", err)
	}
	var req request
	if err := json.Unmarshal(raw, &req); err != nil {
		return fmt.Errorf("bad request json (want {root, files}): %w", err)
	}
	root, err := filepath.Abs(req.Root)
	if err != nil {
		return err
	}

	e := &extractor{
		root:     root,
		results:  map[string]*result{},
		relToID:  map[string]string{},
		funcToID: map[string]string{},
		relFile:  map[string]string{},
	}

	// every claimed file gets its file-level module symbol first (the librarian
	// per-file anchor + degrade fallback), before any statement symbols.
	type parsedFile struct {
		file   string
		src    []byte
		parsed *pg_query.ParseResult
	}
	var parsedFiles []parsedFile
	for _, f := range req.Files {
		abs := f
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(root, abs)
		}
		rel := e.rel(abs)
		srcBytes, rerr := os.ReadFile(abs)
		if rerr != nil {
			fmt.Fprintf(os.Stderr, "warn: %s: %v\n", rel, rerr)
			srcBytes = nil
		}
		e.results[rel] = &result{
			File: rel,
			Symbols: []symbolRow{{
				ID: moduleID(rel), Kind: "module", Name: rel, File: rel,
				SpanStart: 1, SpanEnd: countLines(srcBytes),
			}},
			Edges: []edgeRow{},
		}
		if srcBytes == nil {
			continue
		}
		parsed, perr := pg_query.Parse(string(srcBytes))
		if perr != nil {
			// degrade: keep the file-module symbol, skip its statements (other
			// dialects / templated SQL — missing over false edges)
			fmt.Fprintf(os.Stderr, "warn: %s: %v\n", rel, perr)
			continue
		}
		parsedFiles = append(parsedFiles, parsedFile{rel, srcBytes, parsed})
	}

	// pass 1: symbols across all files (the name tables must be complete before
	// pass 2 resolves cross-file references)
	for _, p := range parsedFiles {
		e.collectStatements(p.file, p.src, p.parsed)
	}
	// pass 2: edges
	e.collectEdges()

	files := make([]string, 0, len(e.results))
	for f := range e.results {
		files = append(files, f)
	}
	sort.Strings(files)
	for _, f := range files {
		r := e.results[f]
		sortSymbols(r.Symbols)
		r.Edges = sortEdges(dedupeEdges(r.Edges))
	}
	return e.emitEnvelope(files)
}

func sortSymbols(syms []symbolRow) {
	sort.SliceStable(syms, func(i, j int) bool {
		if syms[i].SpanStart != syms[j].SpanStart {
			return syms[i].SpanStart < syms[j].SpanStart
		}
		return syms[i].Name < syms[j].Name
	})
}

func sortEdges(edges []edgeRow) []edgeRow {
	sort.SliceStable(edges, func(i, j int) bool {
		if edges[i].FromID != edges[j].FromID {
			return edges[i].FromID < edges[j].FromID
		}
		if edges[i].Kind != edges[j].Kind {
			return edges[i].Kind < edges[j].Kind
		}
		return edges[i].ToName < edges[j].ToName
	})
	return edges
}

// capabilities answers the plugin-protocol handshake (issue #22 / ADR-7): one
// JSON line, no stdin read, exit 0. `dialect` announces the single dialect
// this build parses (issue #36) — consumers ignore unknown fields.
func capabilities() error {
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"protocol":        "librarian-scip-plus",
		"protocolVersion": 1,
		"name":            monikerScheme,
		"extensions":      []string{".sql"},
		"dialect":         "postgresql",
	})
}

func main() {
	for _, a := range os.Args[1:] {
		if a == "--capabilities" {
			if err := capabilities(); err != nil {
				fmt.Fprintln(os.Stderr, "error:", err)
				os.Exit(1)
			}
			return
		}
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
