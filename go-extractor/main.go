// librarian-go-extractor — the Go implementation of the Extractor seam
// (src/extractor.ts, architecture §4-①, ADR-2 multi-language path).
//
// librarian spawns this binary as a child process. Contract (SCIP+ envelope,
// issue #16 / docs/scip-design.md §4):
//
//	stdin:  {"root": "/abs/repo", "files": ["/abs/repo/a.go", ...]}
//	stdout: {"scip": <scip.Index, proto3 canonical JSON>, "ext": {...}}
//
// The scip half is a standards-compliant SCIP index (definitions with
// enclosing ranges, reference/import occurrences, implements relationships)
// that any SCIP consumer can read. The ext half is the sidecar carrying what
// SCIP cannot express: the edge taxonomy (calls vs references — SCIP has no
// call role), unresolved references, and testblocks as first-class nested
// symbols. Ingest (src/scip-ingest.ts) treats ext as the source of truth for
// edges; the base layer is a lossy projection.
//
// Resolution comes from golang.org/x/tools/go/packages (the type checker,
// not syntax): edges that land on a symbol declared in a claimed file are
// stored resolved; everything else (stdlib, external modules, type errors)
// is kept with resolved=false and the callee text as written — completeness
// is sacrificed, measurability is not (same policy as the TS extractor).
//
// Symbol ids reuse librarian's scheme — sha256(file::container::name::kind)
// hex-truncated to 20 — so rows from both languages coexist in one store.
// Monikers are file-rooted (`librarian-go . . . `+"`file`"+`/Recv#Name().`)
// and never carry the repo dimension.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	scippb "github.com/scip-code/scip/bindings/go/scip"
	"golang.org/x/tools/go/packages"
	"google.golang.org/protobuf/encoding/protojson"
)

type symbolRow struct {
	ID        string
	Kind      string
	Name      string
	File      string
	Container *string
	SpanStart int
	SpanEnd   int
	Signature *string
	Doc       *string
	namePos   token.Pos // decl-name position for the definition occurrence (NoPos for module rows)
	nameLen   int       // byte length of the name as written (0 for synthetic testblock names)
}

type edgeRow struct {
	FromID   string
	ToID     *string
	ToName   string
	Kind     string
	Resolved bool
	refPos   token.Pos // reference-site position (NoPos for implements-derived extends)
	refLen   int
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

func symbolID(file string, container *string, name, kind string) string {
	c := ""
	if container != nil {
		c = *container
	}
	sum := sha256.Sum256([]byte(file + "::" + c + "::" + name + "::" + kind))
	return hex.EncodeToString(sum[:])[:20]
}

// registered symbol span, for innermost-enclosing lookups (the Go analogue of
// the TS extractor walking node parents up to a registered declaration).
type regSym struct {
	id        string
	spanStart int
	spanEnd   int
}

type extractor struct {
	root     string
	fset     *token.FileSet
	claimed  map[string]bool              // rel path -> claimed
	results  map[string]*result           // rel path -> bucket
	idByPos  map[string]string            // "file:line:col" of decl name -> symbol id
	symsIn   map[string][]regSym          // rel path -> registered symbols (decl order)
	pkgOf    map[string]*packages.Package // rel path -> chosen package variant
	astOf    map[string]*ast.File         // rel path -> chosen syntax tree
	modIDs   map[string][]string          // import path -> module-symbol ids of its claimed files
	tbParent map[string]string            // testblock id -> enclosing symbol id (for enclosing_symbol)
}

func (e *extractor) rel(abs string) string {
	r, err := filepath.Rel(e.root, abs)
	if err != nil {
		return abs
	}
	return filepath.ToSlash(r)
}

func (e *extractor) posKey(p token.Pos) string {
	pos := e.fset.Position(p)
	return fmt.Sprintf("%s:%d:%d", pos.Filename, pos.Line, pos.Column)
}

func (e *extractor) line(p token.Pos) int { return e.fset.Position(p).Line }

func (e *extractor) register(file string, id string, start, end int) {
	e.symsIn[file] = append(e.symsIn[file], regSym{id, start, end})
}

// innermost registered symbol containing the line; the file's module id when none.
func (e *extractor) enclosing(file string, line int) string {
	best := e.moduleID(file)
	bestSpan := 1 << 30
	for _, s := range e.symsIn[file] {
		if s.spanStart <= line && line <= s.spanEnd && s.spanEnd-s.spanStart < bestSpan {
			best = s.id
			bestSpan = s.spanEnd - s.spanStart
		}
	}
	return best
}

func (e *extractor) moduleID(file string) string {
	return symbolID(file, nil, file, "module")
}

func str(s string) *string { return &s }

func docText(g *ast.CommentGroup) *string {
	if g == nil {
		return nil
	}
	t := strings.TrimSpace(g.Text())
	if t == "" {
		return nil
	}
	return &t
}

// "(a int, b string) error" — the func type as written, minus the keyword.
func funcSignature(ft *ast.FuncType) *string {
	s := types.ExprString(ft)
	return str(strings.TrimPrefix(s, "func"))
}

var testFuncRe = regexp.MustCompile(`^(Test|Benchmark|Fuzz)\p{Lu}`)

func isTestFile(file string) bool { return strings.HasSuffix(file, "_test.go") }

// ---- pass 1: symbols ----

func (e *extractor) collectSymbols(file string, f *ast.File, pkg *packages.Package) {
	bucket := e.results[file]
	// package clause doc → module doc; signature carries the package name so
	// "package (module 相当)" is visible on the file-level symbol.
	bucket.Symbols[0].Signature = str("package " + f.Name.Name)
	bucket.Symbols[0].Doc = docText(f.Doc)

	usedIDs := map[string]bool{}
	add := func(id, kind, name string, container *string, start, end int, sig, doc *string, namePos token.Pos) {
		bucket.Symbols = append(bucket.Symbols, symbolRow{
			ID: id, Kind: kind, Name: name, File: file, Container: container,
			SpanStart: start, SpanEnd: end, Signature: sig, Doc: doc,
			namePos: namePos, nameLen: len(name),
		})
		e.register(file, id, start, end)
		if namePos.IsValid() {
			e.idByPos[e.posKey(namePos)] = id
		}
	}

	for _, decl := range f.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			start, end := e.line(d.Pos()), e.line(d.End())
			name := d.Name.Name
			if d.Recv != nil && len(d.Recv.List) > 0 {
				recv := receiverName(d.Recv.List[0].Type)
				id := symbolID(file, &recv, name, "method")
				add(id, "method", name, &recv,
					start, end, funcSignature(d.Type), docText(d.Doc), d.Name.Pos())
				container := recv + "." + name
				e.collectSubtests(file, d.Body, &container, id, pkg, usedIDs)
				continue
			}
			kind := "function"
			if isTestFile(file) && testFuncRe.MatchString(name) && len(d.Type.Params.List) == 1 {
				// TestXxx / BenchmarkXxx / FuzzXxx — block-level test symbols,
				// the Go analogue of describe/it (issue #7 scope).
				kind = "testblock"
			}
			id := symbolID(file, nil, name, kind)
			add(id, kind, name, nil,
				start, end, funcSignature(d.Type), docText(d.Doc), d.Name.Pos())
			e.collectSubtests(file, d.Body, &name, id, pkg, usedIDs)
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					kind := "typealias"
					switch s.Type.(type) {
					case *ast.StructType:
						kind = "struct"
					case *ast.InterfaceType:
						kind = "interface"
					}
					doc := docText(s.Doc)
					if doc == nil {
						doc = docText(d.Doc)
					}
					add(symbolID(file, nil, s.Name.Name, kind), kind, s.Name.Name, nil,
						e.line(spec.Pos()), e.line(spec.End()), nil, doc, s.Name.Pos())
				case *ast.ValueSpec:
					for _, n := range s.Names {
						if n.Name == "_" {
							continue
						}
						add(symbolID(file, nil, n.Name, "variable"), "variable", n.Name, nil,
							e.line(spec.Pos()), e.line(spec.End()), nil, docText(s.Doc), n.Pos())
					}
				}
			}
		}
	}
}

// t.Run("title", func(t *testing.T){...}) subtests become nested testblock
// symbols, mirroring the TS extractor's describe/it handling: title-named,
// container-chained, #n-suffixed on collision.
func (e *extractor) collectSubtests(file string, body ast.Node, container *string, parentID string, pkg *packages.Package, usedIDs map[string]bool) {
	if body == nil || !isTestFile(file) {
		return
	}
	bucket := e.results[file]
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || len(call.Args) < 2 {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "Run" {
			return true
		}
		if t := pkg.TypesInfo.TypeOf(sel.X); t == nil || !strings.Contains(t.String(), "testing.") {
			return true
		}
		title := ""
		if lit, ok := call.Args[0].(*ast.BasicLit); ok && lit.Kind == token.STRING {
			title = strings.Trim(lit.Value, "`\"")
		}
		name := fmt.Sprintf("t.Run(%s)", title)
		id := symbolID(file, container, name, "testblock")
		for n := 2; usedIDs[id]; n++ {
			name = fmt.Sprintf("t.Run(%s)#%d", title, n)
			id = symbolID(file, container, name, "testblock")
		}
		usedIDs[id] = true
		e.tbParent[id] = parentID
		start, end := e.line(call.Pos()), e.line(call.End())
		bucket.Symbols = append(bucket.Symbols, symbolRow{
			ID: id, Kind: "testblock", Name: name, File: file, Container: container,
			SpanStart: start, SpanEnd: end,
			namePos: call.Pos(), nameLen: 0, // synthetic name — empty range at the t.Run call
		})
		e.register(file, id, start, end)
		child := name
		if container != nil {
			child = *container + "." + name
		}
		for _, arg := range call.Args[1:] {
			if fn, ok := arg.(*ast.FuncLit); ok {
				e.collectSubtests(file, fn.Body, &child, id, pkg, usedIDs)
			}
		}
		return false
	})
}

func receiverName(t ast.Expr) string {
	switch x := t.(type) {
	case *ast.StarExpr:
		return receiverName(x.X)
	case *ast.Ident:
		return x.Name
	case *ast.IndexExpr: // generic receiver T[P]
		return receiverName(x.X)
	case *ast.IndexListExpr:
		return receiverName(x.X)
	}
	return types.ExprString(t)
}

// ---- pass 2: edges ----

// resolve a used object to a registered symbol id: direct decl-name hit
// first, then the innermost registered symbol enclosing the declaration
// (interface methods and struct fields resolve to their owning type — the
// Go analogue of the TS extractor walking up to a registered parent node).
func (e *extractor) resolveObj(obj types.Object) *string {
	if obj == nil || obj.Pos() == token.NoPos {
		return nil
	}
	if id, ok := e.idByPos[e.posKey(obj.Pos())]; ok {
		return &id
	}
	pos := e.fset.Position(obj.Pos())
	rel := e.rel(pos.Filename)
	if !e.claimed[rel] {
		return nil
	}
	id := e.enclosing(rel, pos.Line)
	return &id
}

func (e *extractor) collectEdges(file string, f *ast.File, pkg *packages.Package) {
	bucket := e.results[file]
	info := pkg.TypesInfo
	moduleID := e.moduleID(file)

	addEdge := func(fromID string, toID *string, toName, kind string, refPos token.Pos, refLen int) {
		if toID != nil && *toID == fromID {
			return // self loops are noise
		}
		bucket.Edges = append(bucket.Edges, edgeRow{
			FromID: fromID, ToID: toID, ToName: toName, Kind: kind, Resolved: toID != nil,
			refPos: refPos, refLen: refLen,
		})
	}

	// imports: file module → every claimed file-module of the target package;
	// unresolved single edge (raw import path) when the package is external.
	for _, imp := range f.Imports {
		path := strings.Trim(imp.Path.Value, `"`)
		if targets, ok := e.modIDs[path]; ok && len(targets) > 0 {
			for _, tid := range targets {
				tid := tid
				addEdge(moduleID, &tid, path, "imports", imp.Path.Pos(), len(imp.Path.Value))
			}
		} else {
			addEdge(moduleID, nil, path, "imports", imp.Path.Pos(), len(imp.Path.Value))
		}
	}

	calleeIdents := map[*ast.Ident]bool{}

	ast.Inspect(f, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.CallExpr:
			var ident *ast.Ident
			switch fun := x.Fun.(type) {
			case *ast.Ident:
				ident = fun
			case *ast.SelectorExpr:
				ident = fun.Sel
			}
			if ident == nil {
				return true
			}
			obj := info.Uses[ident]
			if obj == nil {
				return true
			}
			switch obj.(type) {
			case *types.Builtin:
				calleeIdents[ident] = true // len/append/make — pure noise, skip
			case *types.Func:
				calleeIdents[ident] = true
				from := e.enclosing(file, e.line(x.Pos()))
				addEdge(from, e.resolveObj(obj), types.ExprString(x.Fun), "calls", ident.Pos(), len(ident.Name))
			case *types.TypeName:
				// conversion T(v): the ident falls through to the
				// references walk below, which is where it belongs
			}
		case *ast.TypeSpec:
			// embedding → extends (struct embedding and interface embedding)
			var fields *ast.FieldList
			switch t := x.Type.(type) {
			case *ast.StructType:
				fields = t.Fields
			case *ast.InterfaceType:
				fields = t.Methods
			}
			if fields == nil {
				return true
			}
			fromID := e.enclosing(file, e.line(x.Pos()))
			for _, fld := range fields.List {
				if len(fld.Names) > 0 {
					continue // named field / method signature, not embedding
				}
				ident := embeddedIdent(fld.Type)
				if ident == nil {
					continue
				}
				if obj := info.Uses[ident]; obj != nil {
					if _, isType := obj.(*types.TypeName); isType {
						calleeIdents[ident] = true
						// extends map to base-layer relationships, not occurrences — no position needed
						addEdge(fromID, e.resolveObj(obj), types.ExprString(fld.Type), "extends", token.NoPos, 0)
					}
				}
			}
		}
		return true
	})

	// references: identifiers used as values (not callees, not declarations,
	// not package names) that resolve inside the repo. Same policy as the TS
	// extractor's isBareReference: only resolved references are stored.
	ast.Inspect(f, func(n ast.Node) bool {
		if imp, ok := n.(*ast.ImportSpec); ok {
			_ = imp
			return false
		}
		ident, ok := n.(*ast.Ident)
		if !ok || calleeIdents[ident] {
			return true
		}
		obj := info.Uses[ident]
		if obj == nil {
			return true
		}
		switch obj.(type) {
		case *types.PkgName, *types.Builtin, *types.Nil, *types.Label:
			return true
		}
		toID := e.resolveObj(obj)
		if toID == nil {
			return true
		}
		from := e.enclosing(file, e.line(ident.Pos()))
		addEdge(from, toID, ident.Name, "references", ident.Pos(), len(ident.Name))
		return true
	})
}

func embeddedIdent(t ast.Expr) *ast.Ident {
	switch x := t.(type) {
	case *ast.StarExpr:
		return embeddedIdent(x.X)
	case *ast.Ident:
		return x
	case *ast.SelectorExpr:
		return x.Sel
	case *ast.IndexExpr:
		return embeddedIdent(x.X)
	case *ast.IndexListExpr:
		return embeddedIdent(x.X)
	}
	return nil
}

// interface satisfaction → extends edges (issue #7: extends = interface
// 実装 + embedding). Pairwise over named types × non-empty interfaces from
// the plain (non-test) package variants, so all types share one coherent
// type-check universe.
func (e *extractor) collectImplements(plain []*packages.Package) {
	type namedDecl struct {
		named *types.Named
		id    string
		file  string
	}
	var concretes, ifaces []namedDecl
	for _, pkg := range plain {
		scope := pkg.Types.Scope()
		for _, name := range scope.Names() {
			tn, ok := scope.Lookup(name).(*types.TypeName)
			if !ok || tn.IsAlias() {
				continue
			}
			named, ok := tn.Type().(*types.Named)
			if !ok {
				continue
			}
			idp, ok := e.idByPos[e.posKey(tn.Pos())]
			if !ok {
				continue
			}
			d := namedDecl{named, idp, e.rel(e.fset.Position(tn.Pos()).Filename)}
			if types.IsInterface(named) {
				if iface, ok := named.Underlying().(*types.Interface); ok && iface.NumMethods() > 0 {
					ifaces = append(ifaces, d)
				}
			} else {
				concretes = append(concretes, d)
			}
		}
	}
	for _, c := range concretes {
		for _, i := range ifaces {
			iface := i.named.Underlying().(*types.Interface)
			if types.Implements(c.named, iface) || types.Implements(types.NewPointer(c.named), iface) {
				bucket := e.results[c.file]
				if bucket == nil {
					continue
				}
				tid := i.id
				bucket.Edges = append(bucket.Edges, edgeRow{
					FromID: c.id, ToID: &tid, ToName: i.named.Obj().Name(), Kind: "extends", Resolved: true,
				})
			}
		}
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

const monikerScheme = "librarian-go"

var simpleIdentRe = regexp.MustCompile(`^[A-Za-z0-9_+$-]+$`)

func escapeIdent(name string) string {
	if simpleIdentRe.MatchString(name) {
		return name
	}
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

// moniker per docs/scip-design.md §4.2: file as namespace descriptor, then the
// container chain (Go containers are always receiver types → '#'), then self.
// The package part stays empty ('. . .'): monikers never carry the repo
// dimension, and Go module paths are a future extension.
func moniker(row *symbolRow) string {
	head := monikerScheme + " . . . " + escapeIdent(row.File) + "/"
	if row.Kind == "module" {
		return head
	}
	if row.Container != nil {
		for _, seg := range strings.Split(*row.Container, ".") {
			head += escapeIdent(seg) + "#"
		}
	}
	switch row.Kind {
	case "function", "method":
		return head + escapeIdent(row.Name) + "()."
	case "struct", "interface":
		return head + escapeIdent(row.Name) + "#"
	default: // typealias, variable
		return head + escapeIdent(row.Name) + "."
	}
}

func scipKind(kind string) scippb.SymbolInformation_Kind {
	switch kind {
	case "module":
		return scippb.SymbolInformation_File
	case "function":
		return scippb.SymbolInformation_Function
	case "method":
		return scippb.SymbolInformation_Method
	case "struct":
		return scippb.SymbolInformation_Struct
	case "interface":
		return scippb.SymbolInformation_Interface
	case "typealias":
		return scippb.SymbolInformation_TypeAlias
	case "variable":
		return scippb.SymbolInformation_Variable
	}
	// testblock: no SCIP kind exists — ext is its source of truth
	return scippb.SymbolInformation_UnspecifiedKind
}

type extSymbol struct {
	Symbol    string  `json:"symbol"`
	Kind      string  `json:"kind"`
	Name      string  `json:"name"`
	Container *string `json:"container"`
	SpanStart int     `json:"spanStart"`
	SpanEnd   int     `json:"spanEnd"`
}

type extEdge struct {
	From     string  `json:"from"`
	To       *string `json:"to"`
	ToName   string  `json:"toName"`
	Kind     string  `json:"kind"`
	Resolved bool    `json:"resolved"`
}

type extDocument struct {
	RelativePath string      `json:"relativePath"`
	Symbols      []extSymbol `json:"symbols"`
	Edges        []extEdge   `json:"edges"`
}

type extPayload struct {
	Version   int           `json:"version"`
	Documents []extDocument `json:"documents"`
}

func (e *extractor) emitEnvelope(files []string) error {
	// scip symbol string (moniker, or a document-local id for testblocks) per
	// symbol id; locals are numbered in collection order, which is span order.
	scipName := map[string]string{}
	rowByID := map[string]*symbolRow{}
	for _, f := range files {
		local := 0
		syms := e.results[f].Symbols
		for i := range syms {
			row := &syms[i]
			rowByID[row.ID] = row
			if row.Kind == "testblock" {
				scipName[row.ID] = fmt.Sprintf("local %d", local)
				local++
			} else {
				scipName[row.ID] = moniker(row)
			}
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
			Language:         "go",
			RelativePath:     f,
			PositionEncoding: scippb.PositionEncoding_UTF8CodeUnitOffsetFromLineStart,
		}
		extDoc := extDocument{RelativePath: f, Symbols: []extSymbol{}, Edges: []extEdge{}}

		for i := range r.Symbols {
			row := &r.Symbols[i]
			sym := scipName[row.ID]

			occ := &scippb.Occurrence{Symbol: sym, SymbolRoles: int32(scippb.SymbolRole_Definition)}
			if row.Kind == "testblock" {
				occ.SymbolRoles |= int32(scippb.SymbolRole_Test)
			}
			nameRange := &scippb.SingleLineRange{Line: int32(row.SpanStart - 1)}
			if row.namePos.IsValid() {
				p := e.fset.Position(row.namePos)
				nameRange = &scippb.SingleLineRange{
					Line:           int32(p.Line - 1),
					StartCharacter: int32(p.Column - 1),
					EndCharacter:   int32(p.Column - 1 + row.nameLen),
				}
			}
			occ.TypedRange = &scippb.Occurrence_SingleLineRange{SingleLineRange: nameRange}
			occ.TypedEnclosingRange = &scippb.Occurrence_MultiLineEnclosingRange{
				MultiLineEnclosingRange: &scippb.MultiLineRange{
					StartLine: int32(row.SpanStart - 1),
					EndLine:   int32(row.SpanEnd),
				},
			}
			doc.Occurrences = append(doc.Occurrences, occ)

			info := &scippb.SymbolInformation{
				Symbol:      sym,
				Kind:        scipKind(row.Kind),
				DisplayName: row.Name,
			}
			if row.Doc != nil {
				info.Documentation = []string{*row.Doc}
			}
			if row.Signature != nil {
				info.SignatureDocumentation = &scippb.Signature{Language: "go", Text: *row.Signature}
			}
			if row.Kind == "testblock" {
				if parent, ok := e.tbParent[row.ID]; ok {
					info.EnclosingSymbol = scipName[parent]
				}
				extDoc.Symbols = append(extDoc.Symbols, extSymbol{
					Symbol: sym, Kind: row.Kind, Name: row.Name, Container: row.Container,
					SpanStart: row.SpanStart, SpanEnd: row.SpanEnd,
				})
			}
			for j := range r.Edges {
				edge := &r.Edges[j]
				if edge.Kind == "extends" && edge.FromID == row.ID && edge.ToID != nil {
					if target, ok := scipName[*edge.ToID]; ok {
						info.Relationships = append(info.Relationships, &scippb.Relationship{
							Symbol:           target,
							IsImplementation: true,
						})
					}
				}
			}
			doc.Symbols = append(doc.Symbols, info)
		}

		// edges: all of them go to ext (the source of truth); resolved
		// calls/references/imports additionally project to base occurrences.
		// extends live on relationships, unresolved references have no SCIP form.
		for j := range r.Edges {
			edge := &r.Edges[j]
			from := scipName[edge.FromID]
			var to *string
			if edge.ToID != nil {
				if t, ok := scipName[*edge.ToID]; ok {
					// a local of another document is unrepresentable on both
					// layers — cannot happen for Go (no top-level decl sits
					// inside a testblock span), so downgrade loudly if it does
					if strings.HasPrefix(t, "local ") && rowByID[*edge.ToID].File != f {
						fmt.Fprintf(os.Stderr, "warn: %s: dropping cross-file edge into test block %q\n",
							f, rowByID[*edge.ToID].Name)
					} else {
						to = &t
					}
				}
			}
			extDoc.Edges = append(extDoc.Edges, extEdge{
				From: from, To: to, ToName: edge.ToName, Kind: edge.Kind, Resolved: to != nil,
			})
			if to == nil || edge.Kind == "extends" || !edge.refPos.IsValid() {
				continue
			}
			p := e.fset.Position(edge.refPos)
			refOcc := &scippb.Occurrence{
				Symbol: *to,
				TypedRange: &scippb.Occurrence_SingleLineRange{SingleLineRange: &scippb.SingleLineRange{
					Line:           int32(p.Line - 1),
					StartCharacter: int32(p.Column - 1),
					EndCharacter:   int32(p.Column - 1 + edge.refLen),
				}},
			}
			if edge.Kind == "imports" {
				refOcc.SymbolRoles = int32(scippb.SymbolRole_Import)
			}
			doc.Occurrences = append(doc.Occurrences, refOcc)
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

func countLines(path string) int {
	b, err := os.ReadFile(path)
	if err != nil {
		return 1
	}
	n := 1 + strings.Count(string(b), "\n")
	if len(b) > 0 && b[len(b)-1] == '\n' {
		n--
	}
	if n < 1 {
		n = 1
	}
	return n
}

func isPlain(pkg *packages.Package) bool {
	return !strings.Contains(pkg.ID, " [") && !strings.HasSuffix(pkg.ID, ".test")
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
		fset:     token.NewFileSet(),
		claimed:  map[string]bool{},
		results:  map[string]*result{},
		idByPos:  map[string]string{},
		symsIn:   map[string][]regSym{},
		pkgOf:    map[string]*packages.Package{},
		astOf:    map[string]*ast.File{},
		modIDs:   map[string][]string{},
		tbParent: map[string]string{},
	}
	for _, f := range req.Files {
		abs := f
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(root, abs)
		}
		rel := e.rel(abs)
		e.claimed[rel] = true
		// every claimed file gets at least its file-level module symbol, so
		// files the go toolchain ignores (build tags, testdata/) still exist
		// in the store and diff seeding can fall back to them.
		mod := symbolRow{
			ID: e.moduleID(rel), Kind: "module", Name: rel, File: rel,
			Container: nil, SpanStart: 1, SpanEnd: countLines(abs),
		}
		e.results[rel] = &result{File: rel, Symbols: []symbolRow{mod}, Edges: []edgeRow{}}
	}

	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles |
			packages.NeedImports | packages.NeedDeps | packages.NeedTypes |
			packages.NeedSyntax | packages.NeedTypesInfo | packages.NeedModule,
		Dir:   root,
		Fset:  e.fset,
		Tests: true,
	}
	pkgs, err := packages.Load(cfg, "./...")
	if err != nil {
		return fmt.Errorf("go/packages load failed (is %s a Go module?): %w", root, err)
	}
	for _, pkg := range pkgs {
		for _, perr := range pkg.Errors {
			fmt.Fprintf(os.Stderr, "warn: %s: %s\n", pkg.ID, perr.Msg)
		}
	}

	// choose one package variant per file: plain packages first (one coherent
	// type universe for production code), test variants after (they claim the
	// _test.go files the plain variant doesn't contain).
	var plain, testVariants []*packages.Package
	for _, pkg := range pkgs {
		if isPlain(pkg) {
			plain = append(plain, pkg)
		} else if !strings.HasSuffix(pkg.ID, ".test") {
			testVariants = append(testVariants, pkg)
		}
	}
	assign := func(list []*packages.Package) {
		for _, pkg := range list {
			for i, f := range pkg.Syntax {
				rel := e.rel(pkg.CompiledGoFiles[i])
				if e.claimed[rel] && e.pkgOf[rel] == nil {
					e.pkgOf[rel] = pkg
					e.astOf[rel] = f
				}
			}
		}
	}
	assign(plain)
	assign(testVariants)

	// import path → claimed module symbols of that package (plain files only)
	for _, pkg := range plain {
		for _, gf := range pkg.GoFiles {
			rel := e.rel(gf)
			if e.claimed[rel] {
				e.modIDs[pkg.PkgPath] = append(e.modIDs[pkg.PkgPath], e.moduleID(rel))
			}
		}
	}

	files := make([]string, 0, len(e.results))
	for f := range e.results {
		files = append(files, f)
	}
	sort.Strings(files)

	for _, f := range files {
		if e.pkgOf[f] != nil {
			e.collectSymbols(f, e.astOf[f], e.pkgOf[f])
		}
	}
	e.collectImplements(plain)
	for _, f := range files {
		if e.pkgOf[f] != nil {
			e.collectEdges(f, e.astOf[f], e.pkgOf[f])
		}
	}

	for _, f := range files {
		r := e.results[f]
		r.Edges = dedupeEdges(r.Edges)
	}
	return e.emitEnvelope(files)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
