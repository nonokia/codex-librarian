// librarian-tf-extractor — the Terraform (HCL) implementation of the Extractor
// seam (issue #9, ADR-2 multi-language path; ADR-7 plugin protocol).
//
// Unlike the Go/PHP legs this is NOT a call graph: HCL has no dynamic dispatch
// and references are lexically explicit (var.x / module.y.out / aws_x.y.attr),
// so a syntax-level parse (hashicorp/hcl) is sufficient. ADR-2's "type
// resolution required" is a call-graph-language judgment that does not apply to
// HCL — a Go/PHP-style type checker would buy nothing here (this interpretation
// is recorded in dlog). The graph produced is a resource/module *reference*
// graph; its value is diff blast radius (a changed variable → the resources it
// feeds land in the Context Pack's related section).
//
// Contract is identical to go-extractor (SCIP+ envelope, issue #16 /
// docs/scip-design.md §4):
//
//	stdin:  {"root": "/abs/repo", "files": ["/abs/repo/main.tf", ...]}
//	stdout: {"scip": <scip.Index, proto3 canonical JSON>, "ext": {...}}
//
// Symbol ids reuse librarian's scheme — sha256(file::container::name::kind)
// hex-truncated to 20. Every symbol is a top-level block addressed by its
// Terraform reference name, so edge resolution is a string lookup on that name:
//
//	resource "aws_instance" "web"  → aws_instance.web   (kind resource)
//	data     "aws_ami"      "ubu"  → data.aws_ami.ubu   (kind data)
//	variable "region"              → var.region         (kind variable)
//	output   "ip"                  → output.ip          (kind output)
//	module   "vpc"                 → module.vpc         (kind module)
//	locals { tags = ... }          → local.tags         (kind locals)
//
// The file itself is a module symbol (name === file), the librarian per-file
// anchor. `module` blocks reuse librarian kind `module` too; the file symbol
// and a module block are distinguished purely by the moniker (bare file head
// vs a term descriptor), never by kind. All TF symbols have a nil container.
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

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	scippb "github.com/scip-code/scip/bindings/go/scip"
	"github.com/zclconf/go-cty/cty"
	"google.golang.org/protobuf/encoding/protojson"
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
	// container is always empty for Terraform symbols.
	sum := sha256.Sum256([]byte(file + "::" + "" + "::" + name + "::" + kind))
	return hex.EncodeToString(sum[:])[:20]
}

func moduleID(file string) string { return symbolID(file, file, "module") }

// edgeSource pairs a resolved symbol id with the block body whose expressions
// reference other symbols. Collected in pass 1, walked in pass 2 once the
// repo-global address table is complete (cross-file references need it).
type edgeSource struct {
	fromID string
	file   string
	body   *hclsyntax.Body
	// module blocks only: the raw `source` for an imports edge
	moduleSource string
}

type extractor struct {
	root      string
	claimed   map[string]bool       // rel path -> claimed
	results   map[string]*result    // rel path -> bucket
	addrToID  map[string]string     // TF reference address -> symbol id (repo-global)
	fileByDir map[string][]string   // dir (rel) -> module ids of its .tf files (local module resolution)
	sources   []edgeSource          // deferred edge extraction
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
	// A repeated address (e.g. two resources with the same type+name across
	// files — invalid Terraform, but we must not panic) keeps the first.
	if _, ok := e.addrToID[name]; !ok {
		e.addrToID[name] = id
	}
	return id
}

// ---- pass 1: symbols ----

func (e *extractor) collectSymbols(file string, body *hclsyntax.Body) {
	for _, blk := range body.Blocks {
		switch blk.Type {
		case "resource":
			if len(blk.Labels) >= 2 {
				name := blk.Labels[0] + "." + blk.Labels[1]
				id := e.addSymbol(file, name, "resource", blockStart(blk), blockEnd(blk))
				e.sources = append(e.sources, edgeSource{fromID: id, file: file, body: blk.Body})
			}
		case "data":
			if len(blk.Labels) >= 2 {
				name := "data." + blk.Labels[0] + "." + blk.Labels[1]
				id := e.addSymbol(file, name, "data", blockStart(blk), blockEnd(blk))
				e.sources = append(e.sources, edgeSource{fromID: id, file: file, body: blk.Body})
			}
		case "variable":
			if len(blk.Labels) >= 1 {
				name := "var." + blk.Labels[0]
				id := e.addSymbol(file, name, "variable", blockStart(blk), blockEnd(blk))
				e.sources = append(e.sources, edgeSource{fromID: id, file: file, body: blk.Body})
			}
		case "output":
			if len(blk.Labels) >= 1 {
				name := "output." + blk.Labels[0]
				id := e.addSymbol(file, name, "output", blockStart(blk), blockEnd(blk))
				e.sources = append(e.sources, edgeSource{fromID: id, file: file, body: blk.Body})
			}
		case "module":
			if len(blk.Labels) >= 1 {
				name := "module." + blk.Labels[0]
				id := e.addSymbol(file, name, "module", blockStart(blk), blockEnd(blk))
				e.sources = append(e.sources, edgeSource{
					fromID: id, file: file, body: blk.Body, moduleSource: staticString(blk.Body, "source"),
				})
			}
		case "locals":
			// each attribute is an independently-referenceable local
			names := make([]string, 0, len(blk.Body.Attributes))
			for n := range blk.Body.Attributes {
				names = append(names, n)
			}
			sort.Strings(names)
			for _, n := range names {
				attr := blk.Body.Attributes[n]
				name := "local." + n
				id := e.addSymbol(file, name, "locals",
					attr.SrcRange.Start.Line, attr.SrcRange.End.Line)
				e.sources = append(e.sources, edgeSource{
					fromID: id, file: file, body: &hclsyntax.Body{Attributes: hclsyntax.Attributes{n: attr}},
				})
			}
			// provider / terraform / moved / import / check: not reference-graph
			// nodes — skipped (references INTO them still degrade to unresolved).
		}
	}
}

func blockStart(blk *hclsyntax.Block) int { return blk.TypeRange.Start.Line }
func blockEnd(blk *hclsyntax.Block) int {
	if blk.CloseBraceRange.End.Line >= blk.TypeRange.Start.Line {
		return blk.CloseBraceRange.End.Line
	}
	return blk.TypeRange.Start.Line
}

// staticString returns a body attribute's value when it is a constant string
// (no interpolation), else "". Used for a module block's `source`.
func staticString(body *hclsyntax.Body, name string) string {
	attr, ok := body.Attributes[name]
	if !ok {
		return ""
	}
	v, diags := attr.Expr.Value(nil)
	if diags.HasErrors() || v.IsNull() || v.Type() != cty.String {
		return ""
	}
	return v.AsString()
}

// ---- pass 2: edges ----

func (e *extractor) collectEdges() {
	for _, src := range e.sources {
		bucket := e.results[src.file]
		if src.moduleSource != "" {
			e.addModuleImports(bucket, src)
		}
		e.walkRefs(bucket, src.fromID, src.body)
	}
}

func (e *extractor) walkRefs(bucket *result, fromID string, body *hclsyntax.Body) {
	// deterministic attribute order
	names := make([]string, 0, len(body.Attributes))
	for n := range body.Attributes {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		for _, tr := range body.Attributes[n].Expr.Variables() {
			e.addRefEdge(bucket, fromID, tr)
		}
	}
	for _, nb := range body.Blocks {
		e.walkRefs(bucket, fromID, nb.Body)
	}
}

func (e *extractor) addRefEdge(bucket *result, fromID string, tr hcl.Traversal) {
	addr, ok := refAddress(tr)
	if !ok {
		return
	}
	toID, resolved := e.addrToID[addr]
	if resolved && toID == fromID {
		return // self loops are noise
	}
	if resolved {
		to := toID
		bucket.Edges = append(bucket.Edges, edgeRow{
			FromID: fromID, ToID: &to, ToName: addr, Kind: "references", Resolved: true,
		})
	} else {
		// provider / registry / cross-module output not indexed here → unresolved,
		// raw name kept (measurability over completeness, architecture §8-2).
		bucket.Edges = append(bucket.Edges, edgeRow{
			FromID: fromID, ToID: nil, ToName: addr, Kind: "references", Resolved: false,
		})
	}
}

// addModuleImports emits an `imports` edge for a module block's `source`. Local
// relative sources resolve to the file-module symbols of the target directory's
// .tf files; registry/remote sources (and unresolvable local paths) stay
// unresolved with the raw source string.
func (e *extractor) addModuleImports(bucket *result, src edgeSource) {
	source := src.moduleSource
	if strings.HasPrefix(source, "./") || strings.HasPrefix(source, "../") {
		dir := filepath.ToSlash(filepath.Clean(filepath.Join(filepath.Dir(src.file), source)))
		if targets := e.fileByDir[dir]; len(targets) > 0 {
			for _, tid := range targets {
				if tid == src.fromID {
					continue
				}
				to := tid
				bucket.Edges = append(bucket.Edges, edgeRow{
					FromID: src.fromID, ToID: &to, ToName: source, Kind: "imports", Resolved: true,
				})
			}
			return
		}
	}
	bucket.Edges = append(bucket.Edges, edgeRow{
		FromID: src.fromID, ToID: nil, ToName: source, Kind: "imports", Resolved: false,
	})
}

// refAddress maps a traversal to the reference address of the symbol it names,
// or ok=false for built-ins (path/terraform/count/each/self) and bare single
// identifiers (e.g. a `type = string` constraint parses `string` as a root).
func refAddress(tr hcl.Traversal) (string, bool) {
	parts := traversalNames(tr)
	if len(parts) == 0 {
		return "", false
	}
	switch parts[0] {
	case "var", "local", "module":
		if len(parts) >= 2 {
			return parts[0] + "." + parts[1], true
		}
	case "data":
		if len(parts) >= 3 {
			return "data." + parts[1] + "." + parts[2], true
		}
	case "path", "terraform", "count", "each", "self":
		return "", false
	default:
		// resource reference: <type>.<name>
		if len(parts) >= 2 {
			return parts[0] + "." + parts[1], true
		}
	}
	return "", false
}

// traversalNames collects the leading root+attribute identifiers, stopping at
// the first index step ([...]) — an index cannot be part of a symbol address.
func traversalNames(tr hcl.Traversal) []string {
	var out []string
	for _, step := range tr {
		switch s := step.(type) {
		case hcl.TraverseRoot:
			out = append(out, s.Name)
		case hcl.TraverseAttr:
			out = append(out, s.Name)
		default:
			return out
		}
	}
	return out
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

const monikerScheme = "librarian-terraform"

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
// symbol as a term descriptor. The file-module is the bare file head; every
// other TF symbol (including `module` blocks) is a term. The package part stays
// empty ('. . .') — monikers never carry the repo dimension.
func moniker(row symbolRow) string {
	head := monikerScheme + " . . . " + escapeIdent(row.File) + "/"
	if row.Kind == "module" && row.Name == row.File {
		return head
	}
	return head + escapeIdent(row.Name) + "."
}

// scipKind maps librarian kinds to SCIP SymbolInformation_Kind. Must stay the
// exact inverse of KIND_TO_SCIP on the TS side so the moniker/kind round-trip
// holds: module→File and variable→Variable are reused; resource/data/output/
// locals take four otherwise-unused SCIP kinds (issue #9).
func scipKind(kind string) scippb.SymbolInformation_Kind {
	switch kind {
	case "module":
		return scippb.SymbolInformation_File
	case "variable":
		return scippb.SymbolInformation_Variable
	case "resource":
		return scippb.SymbolInformation_Object
	case "data":
		return scippb.SymbolInformation_Value
	case "output":
		return scippb.SymbolInformation_Property
	case "locals":
		return scippb.SymbolInformation_Constant
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
	RelativePath string      `json:"relativePath"`
	Symbols      []struct{}  `json:"symbols"` // TF has no document-local symbols
	Edges        []extEdge   `json:"edges"`
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
			Language:         "terraform",
			RelativePath:     f,
			PositionEncoding: scippb.PositionEncoding_UTF8CodeUnitOffsetFromLineStart,
		}
		extDoc := extDocument{RelativePath: f, Symbols: []struct{}{}, Edges: []extEdge{}}

		for i := range r.Symbols {
			row := r.Symbols[i]
			sym := scipName[row.ID]
			// definition occurrence: the enclosing range is what ingest reads for
			// the row span (the name range is a whole-line placeholder).
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
		root:      root,
		claimed:   map[string]bool{},
		results:   map[string]*result{},
		addrToID:  map[string]string{},
		fileByDir: map[string][]string{},
	}

	// every claimed file gets its file-level module symbol first (the librarian
	// per-file anchor + degrade fallback), before any block symbols.
	type parsed struct {
		file string
		body *hclsyntax.Body
	}
	var bodies []parsed
	for _, f := range req.Files {
		abs := f
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(root, abs)
		}
		rel := e.rel(abs)
		e.claimed[rel] = true
		e.results[rel] = &result{
			File: rel,
			Symbols: []symbolRow{{
				ID: moduleID(rel), Kind: "module", Name: rel, File: rel,
				SpanStart: 1, SpanEnd: countLines(abs),
			}},
			Edges: []edgeRow{},
		}
		dir := filepath.ToSlash(filepath.Dir(rel))
		e.fileByDir[dir] = append(e.fileByDir[dir], moduleID(rel))

		srcBytes, rerr := os.ReadFile(abs)
		if rerr != nil {
			fmt.Fprintf(os.Stderr, "warn: %s: %v\n", rel, rerr)
			continue
		}
		file, diags := hclsyntax.ParseConfig(srcBytes, rel, hcl.Pos{Line: 1, Column: 1})
		if diags.HasErrors() {
			// degrade: keep the file-module symbol, skip its blocks
			fmt.Fprintf(os.Stderr, "warn: %s: %s\n", rel, diags.Error())
			continue
		}
		body, ok := file.Body.(*hclsyntax.Body)
		if !ok {
			continue
		}
		bodies = append(bodies, parsed{rel, body})
	}

	// pass 1: symbols across all files (address table must be complete before
	// pass 2 resolves cross-file references)
	for _, p := range bodies {
		e.collectSymbols(p.file, p.body)
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
// JSON line, no stdin read, exit 0.
func capabilities() error {
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"protocol":        "librarian-scip-plus",
		"protocolVersion": 1,
		"name":            monikerScheme,
		"extensions":      []string{".tf"},
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
