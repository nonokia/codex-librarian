// librarian-dockerfile-extractor — the Dockerfile implementation of the
// Extractor seam (issue #40, ADR-2 multi-language path; ADR-7 plugin protocol).
//
// The parser is BuildKit's own Dockerfile frontend (moby/buildkit
// frontend/dockerfile parser + instructions) — the official implementation
// itself, so heredocs, line continuations, JSON forms and instruction flags
// parse exactly as `docker build` sees them. Like Terraform and SQL this is a
// *reference* graph, not a call graph: multi-stage structure and copy sources
// are lexically explicit, no type resolution applies (recorded in dlog).
//
// Contract is identical to tf-extractor / sql-extractor (SCIP+ envelope):
//
//	stdin:  {"root": "/abs/repo", "files": ["/abs/repo/Dockerfile", ...]}
//	stdout: {"scip": <scip.Index, proto3 canonical JSON>, "ext": {...}}
//
// Symbols are reference addresses; stages are the structure of this language:
//
//	FROM node:22 AS build   → stage.build   (kind stage)
//	ARG NODE_VERSION        → arg.NODE_VERSION (kind variable)
//
// The file itself is a module symbol (name === file). Unnamed stages get no
// symbol; their instructions reference from the file module instead.
//
// Edges (all in-file except image imports):
//   - FROM <prior stage> / COPY --from=<stage> / RUN --mount=from=<stage>
//     → references, resolved to the stage symbol (case-insensitive, or by
//     numeric index when the target stage is named).
//   - FROM/--from/--mount external images → imports, resolved=0, toName is
//     the image specifier normalized by stripping :tag/@digest — the entry
//     point for a future links.json image→repo declaration (#35).
//   - COPY/ADD literal sources that exist (Dockerfile's directory first, then
//     the repo root — the two common build contexts) → references, resolved=0
//     with the repo-relative path: binding to another extractor's file-module
//     row at extract time is impossible (ids are namespaced per run), so the
//     path stays honestly unresolved for a future post-pass. Globs emit the
//     raw pattern unresolved; $-containing and non-existing sources emit
//     nothing (only-if-exists, issue #40).
//   - $VAR/${VAR} usage lines → references to the declared arg.<NAME> only;
//     undeclared variables are shell/env noise and emit nothing.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/moby/buildkit/frontend/dockerfile/instructions"
	"github.com/moby/buildkit/frontend/dockerfile/parser"
	scippb "github.com/scip-code/scip/bindings/go/scip"
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
	sum := sha256.Sum256([]byte(file + "::" + "" + "::" + name + "::" + kind))
	return hex.EncodeToString(sum[:])[:20]
}

func moduleID(file string) string { return symbolID(file, file, "module") }

// normalizeImage strips :tag and @digest from an image reference, keeping
// registry/path — the repository identity a links.json declaration would name.
func normalizeImage(ref string) string {
	if i := strings.Index(ref, "@"); i >= 0 {
		ref = ref[:i]
	}
	if i := strings.LastIndex(ref, ":"); i >= 0 && !strings.Contains(ref[i+1:], "/") {
		ref = ref[:i]
	}
	return ref
}

var varRef = regexp.MustCompile(`\$\{?([A-Za-z_][A-Za-z0-9_]*)`)
var globChars = regexp.MustCompile(`[*?\[]`)

// fileExtractor holds the per-file state: Dockerfile stages are file-scoped,
// so unlike tf/sql there is no repo-global address table.
type fileExtractor struct {
	root   string
	file   string
	bucket *result
	// stage name (lowercased) -> symbol id; and index -> id for named stages
	stageByName  map[string]string
	stageByIndex map[int]string
	argByName    map[string]string
	argLines     map[int]bool // ARG declaration lines (self-reference skip)
	// line -> owning stage symbol id (module id when outside any stage)
	stageOfLine []string
}

func (fe *fileExtractor) addSymbol(name, kind string, start, end int) string {
	id := symbolID(fe.file, name, kind)
	fe.bucket.Symbols = append(fe.bucket.Symbols, symbolRow{
		ID: id, Kind: kind, Name: name, File: fe.file, SpanStart: start, SpanEnd: end,
	})
	return id
}

func (fe *fileExtractor) addEdge(fromID string, toID *string, toName, kind string) {
	fe.bucket.Edges = append(fe.bucket.Edges, edgeRow{
		FromID: fromID, ToID: toID, ToName: toName, Kind: kind, Resolved: toID != nil,
	})
}

// stageTarget resolves a --from/-FROM target that may be a stage name or a
// stage index. Returns the stage symbol id, or "" when it is not a stage
// (an external image, or an unnamed stage we hold no symbol for).
func (fe *fileExtractor) stageTarget(ref string) string {
	if id, ok := fe.stageByName[strings.ToLower(ref)]; ok {
		return id
	}
	if n, err := strconv.Atoi(ref); err == nil {
		if id, ok := fe.stageByIndex[n]; ok {
			return id
		}
	}
	return ""
}

// fromEdge emits the edge for a FROM/--from/--mount=from target: a resolved
// stage reference, or an unresolved image import. A variable in the tag/digest
// is fine (normalizeImage strips that part anyway — `node:${V}-alpine` is
// still repository `node`); a variable in the repository part itself makes
// the specifier non-literal, so nothing is emitted there (the ARG usage scan
// links the variable instead).
func (fe *fileExtractor) fromEdge(fromID, ref string) {
	if ref == "" || ref == "scratch" {
		return
	}
	if id := fe.stageTarget(ref); id != "" {
		if id != fromID {
			fe.addEdge(fromID, &id, ref, "references")
		}
		return
	}
	repo := normalizeImage(ref)
	if repo == "" || strings.Contains(repo, "$") {
		return
	}
	fe.addEdge(fromID, nil, repo, "imports")
}

// copySources emits edges for COPY/ADD source paths (issue #40 rules; see the
// file comment). ctxDirs are tried in order for existence.
func (fe *fileExtractor) copySources(fromID string, sources []string) {
	for _, src := range sources {
		if strings.Contains(src, "$") || strings.HasPrefix(src, "http://") ||
			strings.HasPrefix(src, "https://") || strings.HasPrefix(src, "git@") {
			continue
		}
		if globChars.MatchString(src) {
			fe.addEdge(fromID, nil, src, "references")
			continue
		}
		clean := strings.TrimSuffix(path.Clean(src), "/")
		if clean == "." || clean == "" || strings.HasPrefix(clean, "..") || path.IsAbs(clean) {
			continue
		}
		for _, ctx := range []string{path.Dir(fe.file), "."} {
			rel := path.Join(ctx, clean)
			if _, err := os.Stat(filepath.Join(fe.root, filepath.FromSlash(rel))); err == nil {
				fe.addEdge(fromID, nil, rel, "references")
				break
			}
		}
	}
}

func (fe *fileExtractor) handleCommand(stageID string, cmd instructions.Command) {
	switch c := cmd.(type) {
	case *instructions.ArgCommand:
		for _, kv := range c.Args {
			line := c.Location()[0].Start.Line
			id := fe.addSymbol("arg."+kv.Key, "variable", line, line)
			if _, ok := fe.argByName[kv.Key]; !ok {
				fe.argByName[kv.Key] = id
			}
			fe.argLines[line] = true
		}
	case *instructions.CopyCommand:
		if c.From != "" {
			fe.fromEdge(stageID, c.From)
		}
		fe.copySources(stageID, c.SourcePaths)
	case *instructions.AddCommand:
		fe.copySources(stageID, c.SourcePaths)
	case *instructions.RunCommand:
		for _, m := range instructions.GetMounts(c) {
			if m.From != "" {
				fe.fromEdge(stageID, m.From)
			}
		}
	case *instructions.OnbuildCommand:
		// re-parse the wrapped instruction and attribute it to this stage
		res, err := parser.Parse(strings.NewReader(c.Expression))
		if err != nil || len(res.AST.Children) == 0 {
			return
		}
		inner, err := instructions.ParseInstruction(res.AST.Children[0])
		if err != nil {
			return
		}
		if innerCmd, ok := inner.(instructions.Command); ok {
			fe.handleCommand(stageID, innerCmd)
		}
	}
}

func (fe *fileExtractor) extract(src []byte) {
	lines := strings.Split(string(src), "\n")
	res, err := parser.Parse(strings.NewReader(string(src)))
	if err != nil {
		fmt.Fprintf(os.Stderr, "warn: %s: %v\n", fe.file, err)
		return
	}
	stages, metaArgs, err := instructions.Parse(res.AST, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warn: %s: %v\n", fe.file, err)
		return
	}

	fe.stageOfLine = make([]string, len(lines)+2)
	modID := moduleID(fe.file)
	for i := range fe.stageOfLine {
		fe.stageOfLine[i] = modID
	}

	// global ARGs (before the first FROM)
	for _, ma := range metaArgs {
		for _, kv := range ma.Args {
			line := ma.Location()[0].Start.Line
			id := fe.addSymbol("arg."+kv.Key, "variable", line, line)
			if _, ok := fe.argByName[kv.Key]; !ok {
				fe.argByName[kv.Key] = id
			}
			fe.argLines[line] = true
		}
	}

	// pass 1: stage symbols (spans cover FROM through the last command), so
	// later stages and --from can resolve to any prior stage.
	type stageSpan struct {
		id         string
		start, end int
	}
	spans := make([]stageSpan, len(stages))
	for i, st := range stages {
		start := st.Location[0].Start.Line
		end := st.Location[len(st.Location)-1].End.Line
		for _, cmd := range st.Commands {
			loc := cmd.Location()
			if l := loc[len(loc)-1].End.Line; l > end {
				end = l
			}
		}
		id := modID
		if st.Name != "" {
			id = fe.addSymbol("stage."+st.Name, "stage", start, end)
			fe.stageByName[strings.ToLower(st.Name)] = id
			fe.stageByIndex[i] = id
		}
		spans[i] = stageSpan{id, start, end}
		for l := start; l <= end && l < len(fe.stageOfLine); l++ {
			fe.stageOfLine[l] = id
		}
	}

	// pass 2: edges
	for i, st := range stages {
		fe.fromEdge(spans[i].id, st.BaseName)
		for _, cmd := range st.Commands {
			fe.handleCommand(spans[i].id, cmd)
		}
	}

	// pass 3: ARG usage sites — $VAR/${VAR} on any non-comment line, linked to
	// declared ARGs only, from the stage owning that line.
	seen := map[string]bool{}
	for ln := 1; ln <= len(lines); ln++ {
		text := lines[ln-1]
		if strings.HasPrefix(strings.TrimSpace(text), "#") || fe.argLines[ln] {
			continue
		}
		for _, m := range varRef.FindAllStringSubmatch(text, -1) {
			argID, ok := fe.argByName[m[1]]
			if !ok {
				continue
			}
			fromID := fe.stageOfLine[ln]
			key := fromID + "|" + argID
			if seen[key] || fromID == argID {
				continue
			}
			seen[key] = true
			fe.addEdge(fromID, &argID, "arg."+m[1], "references")
		}
	}
}

// ---- SCIP+ emit (issue #16, docs/scip-design.md §4) ----

const monikerScheme = "librarian-dockerfile"

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

func moniker(row symbolRow) string {
	head := monikerScheme + " . . . " + escapeIdent(row.File) + "/"
	if row.Kind == "module" && row.Name == row.File {
		return head
	}
	return head + escapeIdent(row.Name) + "."
}

// scipKind mirrors the TS-side KIND_TO_SCIP additions for issue #40:
// stage→Package (otherwise unused, bijection kept); variable/module reused.
func scipKind(kind string) scippb.SymbolInformation_Kind {
	switch kind {
	case "module":
		return scippb.SymbolInformation_File
	case "variable":
		return scippb.SymbolInformation_Variable
	case "stage":
		return scippb.SymbolInformation_Package
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
	Symbols      []struct{} `json:"symbols"`
	Edges        []extEdge  `json:"edges"`
}

type extPayload struct {
	Version   int           `json:"version"`
	Documents []extDocument `json:"documents"`
}

func emitEnvelope(root string, files []string, results map[string]*result) error {
	scipName := map[string]string{}
	for _, f := range files {
		for i := range results[f].Symbols {
			row := results[f].Symbols[i]
			scipName[row.ID] = moniker(row)
		}
	}

	index := &scippb.Index{
		Metadata: &scippb.Metadata{
			ToolInfo:             &scippb.ToolInfo{Name: monikerScheme, Version: "0.1.0"},
			ProjectRoot:          "file://" + filepath.ToSlash(root),
			TextDocumentEncoding: scippb.TextEncoding_UTF8,
		},
	}
	extOut := extPayload{Version: 1, Documents: make([]extDocument, 0, len(files))}

	for _, f := range files {
		r := results[f]
		doc := &scippb.Document{
			Language:         "dockerfile",
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

	results := map[string]*result{}
	files := make([]string, 0, len(req.Files))
	for _, f := range req.Files {
		abs := f
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(root, abs)
		}
		rel, rerr := filepath.Rel(root, abs)
		if rerr != nil {
			rel = abs
		}
		rel = filepath.ToSlash(rel)

		srcBytes, rerr2 := os.ReadFile(abs)
		if rerr2 != nil {
			fmt.Fprintf(os.Stderr, "warn: %s: %v\n", rel, rerr2)
			srcBytes = nil
		}
		results[rel] = &result{
			File: rel,
			Symbols: []symbolRow{{
				ID: moduleID(rel), Kind: "module", Name: rel, File: rel,
				SpanStart: 1, SpanEnd: countLines(srcBytes),
			}},
			Edges: []edgeRow{},
		}
		files = append(files, rel)
		if srcBytes == nil {
			continue
		}
		fe := &fileExtractor{
			root: root, file: rel, bucket: results[rel],
			stageByName: map[string]string{}, stageByIndex: map[int]string{},
			argByName: map[string]string{}, argLines: map[int]bool{},
		}
		fe.extract(srcBytes)
	}

	sort.Strings(files)
	for _, f := range files {
		r := results[f]
		sortSymbols(r.Symbols)
		r.Edges = sortEdges(dedupeEdges(r.Edges))
	}
	return emitEnvelope(root, files, results)
}

// capabilities answers the plugin-protocol handshake (issue #22 / ADR-7).
// `basenames` announces the extension-less claim patterns (issue #40);
// consumers ignore unknown fields.
func capabilities() error {
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"protocol":        "librarian-scip-plus",
		"protocolVersion": 1,
		"name":            monikerScheme,
		"extensions":      []string{".dockerfile"},
		"basenames":       []string{"Dockerfile", "Dockerfile.*"},
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
