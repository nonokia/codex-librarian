// librarian-k8s-extractor — the Kubernetes-manifest implementation of the
// Extractor seam (issue #39, ADR-2 multi-language path; ADR-7 plugin protocol).
//
// Scope (v1): plain manifests + Kustomize — both are pure YAML and parse
// deterministically. Helm templates are OUT of scope: `templates/*.yaml` is
// Go-template soup that is usually not valid YAML; it fails parsing and
// degrades to the file-level module symbol (missing over false edges,
// architecture §8 risk 2; recorded in dlog).
//
// Routing: this plugin claims `.yaml`/`.yml` as a built-in, and the k8s
// content gate lives HERE — a document is a k8s resource only when it
// self-declares apiVersion + kind + metadata.name (Kustomization files are
// recognized by kind). Non-k8s YAML yields the file module and nothing else,
// so claiming the generic extensions produces zero false edges. Ansible (#37)
// has no such self-declaration and stays opt-in via .librarian/extractors.json,
// which overrides this built-in for repos that declare it (shared #37/#39
// routing decision, recorded in dlog).
//
// Contract is identical to the other Go legs (SCIP+ envelope):
//
//	stdin:  {"root": "/abs/repo", "files": ["/abs/repo/base/deploy.yaml", ...]}
//	stdout: {"scip": <scip.Index, proto3 canonical JSON>, "ext": {...}}
//
// Symbols are reference addresses reusing SymbolKind `resource` (a declared
// k8s resource and a declared Terraform resource are the same concept to the
// store):
//
//	Deployment/api            (kind/name; one per --- document)
//	prod/Deployment/api       (namespace-qualified when non-default)
//	ConfigMap/prod-config     (also declared by configMapGenerator entries)
//
// Edges:
//   - configMapRef/configMapKeyRef/secretRef/secretKeyRef and volume
//     configMap:/secret: → ConfigMap/Secret by name (fact references).
//   - Ingress spec...backend.service.name → Service.
//   - kustomization documents get their own symbol, Kustomization/<dir>
//     (kustomize composes *resources*, and retrieval seeds document symbols,
//     not file modules); resources:/patches: edges point at the target files'
//     document symbols (imports; directories expand to their claimed files;
//     a file with no documents falls back to its module symbol).
//   - Service spec.selector → the ONE workload whose template labels contain
//     the selector; multiple/zero candidates stay resolved=0 with a canonical
//     `selector:k=v,...` name (never guess — the link/dispatch principle).
//   - container image: → imports resolved=0 with the tag/digest-stripped
//     repository name (the same links.json specifier the dockerfile
//     extractor emits, #35/#40).
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
	"sort"
	"strings"

	scippb "github.com/scip-code/scip/bindings/go/scip"
	"google.golang.org/protobuf/encoding/protojson"
	"gopkg.in/yaml.v3"
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

// normalizeImage strips :tag and @digest — must stay in lockstep with the
// dockerfile extractor so both emit the same #35 specifier.
func normalizeImage(ref string) string {
	if i := strings.Index(ref, "@"); i >= 0 {
		ref = ref[:i]
	}
	if i := strings.LastIndex(ref, ":"); i >= 0 && !strings.Contains(ref[i+1:], "/") {
		ref = ref[:i]
	}
	return ref
}

// workloadKinds carry pod templates whose labels a Service selector can match.
var workloadKinds = map[string]bool{
	"Deployment": true, "StatefulSet": true, "DaemonSet": true,
	"ReplicaSet": true, "Job": true,
}

// resourceDoc is one k8s document found in a file.
type resourceDoc struct {
	file      string
	id        string
	kind      string
	name      string
	namespace string
	node      *yaml.Node // the document mapping node
	start     int
	end       int
	// workloads only: spec.template.metadata.labels
	templateLabels map[string]string
}

type extractor struct {
	root    string
	results map[string]*result
	// address ("Deployment/api" and "ns/Deployment/api") -> symbol id
	addrToID map[string]string
	// claimed rel file -> module id (kustomize fallback for empty files)
	fileModule map[string]string
	// rel file -> document symbol ids (kustomize targets resolve to these)
	docsByFile map[string][]string
	docs       []*resourceDoc
	// kustomization buckets deferred to pass 2
	kustomizations []kustomization
}

type kustomization struct {
	file    string
	fromID  string
	targets []string // file/dir paths as written
}

// ---- YAML helpers ----

func mapGet(n *yaml.Node, key string) *yaml.Node {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1]
		}
	}
	return nil
}

func scalar(n *yaml.Node) string {
	if n != nil && n.Kind == yaml.ScalarNode {
		return n.Value
	}
	return ""
}

func stringMap(n *yaml.Node) map[string]string {
	out := map[string]string{}
	if n == nil || n.Kind != yaml.MappingNode {
		return out
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Kind == yaml.ScalarNode && n.Content[i+1].Kind == yaml.ScalarNode {
			out[n.Content[i].Value] = n.Content[i+1].Value
		}
	}
	return out
}

func maxLine(n *yaml.Node) int {
	if n == nil {
		return 0
	}
	m := n.Line
	for _, c := range n.Content {
		if l := maxLine(c); l > m {
			m = l
		}
	}
	return m
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

func (e *extractor) register(addr, id string) {
	if _, ok := e.addrToID[addr]; !ok {
		e.addrToID[addr] = id
	}
}

// ---- pass 1: documents → symbols ----

func (e *extractor) collectFile(file string, src []byte) {
	dec := yaml.NewDecoder(strings.NewReader(string(src)))
	var docNodes []*yaml.Node
	for {
		var n yaml.Node
		if err := dec.Decode(&n); err != nil {
			if err == io.EOF {
				break
			}
			// not valid YAML (Helm template, etc.) — degrade to the module symbol
			fmt.Fprintf(os.Stderr, "warn: %s: %v\n", file, err)
			return
		}
		if len(n.Content) > 0 {
			docNodes = append(docNodes, n.Content[0])
		}
	}
	totalLines := 1 + strings.Count(string(src), "\n")

	for i, doc := range docNodes {
		if doc.Kind != yaml.MappingNode {
			continue
		}
		end := totalLines
		if i+1 < len(docNodes) {
			end = docNodes[i+1].Line - 1
		}
		if m := maxLine(doc); m < end && i+1 == len(docNodes) {
			end = totalLines
		}

		kind := scalar(mapGet(doc, "kind"))
		apiVersion := scalar(mapGet(doc, "apiVersion"))
		meta := mapGet(doc, "metadata")
		name := scalar(mapGet(meta, "name"))

		if kind == "Kustomization" && apiVersion != "" {
			e.collectKustomization(file, doc)
			continue
		}
		// the k8s content gate: self-declared resources only
		if kind == "" || apiVersion == "" || name == "" {
			continue
		}
		ns := scalar(mapGet(meta, "namespace"))
		addr := kind + "/" + name
		display := addr
		if ns != "" && ns != "default" {
			display = ns + "/" + addr
		}
		id := e.addSymbol(file, display, "resource", doc.Line, end)
		e.register(display, id)
		e.register(addr, id)
		e.docsByFile[file] = append(e.docsByFile[file], id)

		rd := &resourceDoc{
			file: file, id: id, kind: kind, name: name, namespace: ns,
			node: doc, start: doc.Line, end: end,
		}
		if workloadKinds[kind] {
			rd.templateLabels = stringMap(
				mapGet(mapGet(mapGet(mapGet(doc, "spec"), "template"), "metadata"), "labels"))
		}
		e.docs = append(e.docs, rd)
	}
}

// collectKustomization gives the kustomization document its own symbol
// (named by its directory — kustomizations rarely carry metadata.name),
// records the generated ConfigMap/Secret symbols, and defers its file/dir
// targets to pass 2.
func (e *extractor) collectKustomization(file string, doc *yaml.Node) {
	end := maxLine(doc)
	name := "Kustomization/" + path.Dir(file)
	fromID := e.addSymbol(file, name, "resource", doc.Line, end)
	e.register(name, fromID)
	e.docsByFile[file] = append(e.docsByFile[file], fromID)
	k := kustomization{file: file, fromID: fromID}
	for _, key := range []string{"resources", "patchesStrategicMerge"} {
		if list := mapGet(doc, key); list != nil && list.Kind == yaml.SequenceNode {
			for _, item := range list.Content {
				if s := scalar(item); s != "" {
					k.targets = append(k.targets, s)
				}
			}
		}
	}
	if patches := mapGet(doc, "patches"); patches != nil && patches.Kind == yaml.SequenceNode {
		for _, p := range patches.Content {
			if s := scalar(mapGet(p, "path")); s != "" {
				k.targets = append(k.targets, s)
			}
		}
	}
	// generators declare the ConfigMap/Secret they will produce, so name
	// references to them resolve here.
	for key, kindName := range map[string]string{
		"configMapGenerator": "ConfigMap",
		"secretGenerator":    "Secret",
	} {
		if list := mapGet(doc, key); list != nil && list.Kind == yaml.SequenceNode {
			for _, g := range list.Content {
				name := scalar(mapGet(g, "name"))
				if name == "" {
					continue
				}
				addr := kindName + "/" + name
				id := e.addSymbol(file, addr, "resource", g.Line, maxLine(g))
				e.register(addr, id)
				e.docsByFile[file] = append(e.docsByFile[file], id)
			}
		}
	}
	e.kustomizations = append(e.kustomizations, k)
}

// ---- pass 2: edges ----

func (e *extractor) addRef(bucket *result, fromID, addr string) {
	toID, ok := e.addrToID[addr]
	if ok && toID == fromID {
		return
	}
	if ok {
		to := toID
		bucket.Edges = append(bucket.Edges, edgeRow{FromID: fromID, ToID: &to, ToName: addr, Kind: "references", Resolved: true})
	} else {
		bucket.Edges = append(bucket.Edges, edgeRow{FromID: fromID, ToID: nil, ToName: addr, Kind: "references", Resolved: false})
	}
}

// nameRefs walks a document for the reference-by-name key shapes.
func (e *extractor) nameRefs(bucket *result, fromID string, n *yaml.Node) {
	if n == nil {
		return
	}
	if n.Kind == yaml.MappingNode {
		for i := 0; i+1 < len(n.Content); i += 2 {
			key, val := n.Content[i].Value, n.Content[i+1]
			switch key {
			case "configMapRef", "configMapKeyRef":
				if name := scalar(mapGet(val, "name")); name != "" {
					e.addRef(bucket, fromID, "ConfigMap/"+name)
				}
			case "secretRef", "secretKeyRef":
				if name := scalar(mapGet(val, "name")); name != "" {
					e.addRef(bucket, fromID, "Secret/"+name)
				}
			case "configMap":
				if name := scalar(mapGet(val, "name")); name != "" {
					e.addRef(bucket, fromID, "ConfigMap/"+name)
				}
			case "secret":
				if name := scalar(mapGet(val, "secretName")); name != "" {
					e.addRef(bucket, fromID, "Secret/"+name)
				}
			case "image":
				if img := scalar(val); img != "" && !strings.Contains(img, "$") {
					repo := normalizeImage(img)
					if repo != "" {
						bucket.Edges = append(bucket.Edges, edgeRow{
							FromID: fromID, ToID: nil, ToName: repo, Kind: "imports", Resolved: false,
						})
					}
				}
			}
			e.nameRefs(bucket, fromID, val)
		}
		return
	}
	for _, c := range n.Content {
		e.nameRefs(bucket, fromID, c)
	}
}

// ingressRefs: spec.rules[].http.paths[].backend.service.name → Service
// (and the legacy spec.defaultBackend.service.name).
func (e *extractor) ingressRefs(bucket *result, doc *resourceDoc) {
	var walk func(n *yaml.Node)
	walk = func(n *yaml.Node) {
		if n == nil {
			return
		}
		if n.Kind == yaml.MappingNode {
			if svc := mapGet(n, "service"); svc != nil {
				if name := scalar(mapGet(svc, "name")); name != "" {
					e.addRef(bucket, doc.id, "Service/"+name)
				}
			}
			for i := 1; i < len(n.Content); i += 2 {
				walk(n.Content[i])
			}
			return
		}
		for _, c := range n.Content {
			walk(c)
		}
	}
	walk(mapGet(doc.node, "spec"))
}

// selectorRefs binds a Service's spec.selector to the single workload whose
// template labels contain every selector pair; ambiguity stays unresolved.
func (e *extractor) selectorRefs(bucket *result, doc *resourceDoc) {
	sel := stringMap(mapGet(mapGet(doc.node, "spec"), "selector"))
	if len(sel) == 0 {
		return
	}
	var matches []*resourceDoc
	for _, cand := range e.docs {
		if cand.templateLabels == nil {
			continue
		}
		ok := true
		for k, v := range sel {
			if cand.templateLabels[k] != v {
				ok = false
				break
			}
		}
		if ok {
			matches = append(matches, cand)
		}
	}
	keys := make([]string, 0, len(sel))
	for k := range sel {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = k + "=" + sel[k]
	}
	canonical := "selector:" + strings.Join(parts, ",")
	if len(matches) == 1 {
		to := matches[0].id
		bucket.Edges = append(bucket.Edges, edgeRow{
			FromID: doc.id, ToID: &to, ToName: canonical, Kind: "references", Resolved: true,
		})
		return
	}
	bucket.Edges = append(bucket.Edges, edgeRow{
		FromID: doc.id, ToID: nil, ToName: canonical, Kind: "references", Resolved: false,
	})
}

// kustomizeEdges resolves resources/patches targets to the referenced files'
// document symbols (a file with no documents falls back to its module symbol;
// directories expand to every claimed YAML file under them). Document symbols
// — not file modules — because kustomize composes resources, and retrieval
// seeds documents.
func (e *extractor) kustomizeEdges() {
	targetIDs := func(file string) []string {
		if ids := e.docsByFile[file]; len(ids) > 0 {
			return ids
		}
		if id, ok := e.fileModule[file]; ok {
			return []string{id}
		}
		return nil
	}
	for _, k := range e.kustomizations {
		bucket := e.results[k.file]
		dir := path.Dir(k.file)
		for _, target := range k.targets {
			resolved := path.Clean(path.Join(dir, target))
			var ids []string
			if _, ok := e.fileModule[resolved]; ok {
				ids = targetIDs(resolved)
			} else {
				for _, f := range e.filesInDir(resolved) {
					ids = append(ids, targetIDs(f)...)
				}
			}
			if len(ids) == 0 {
				bucket.Edges = append(bucket.Edges, edgeRow{
					FromID: k.fromID, ToID: nil, ToName: target, Kind: "imports", Resolved: false,
				})
				continue
			}
			for _, id := range ids {
				if id == k.fromID {
					continue
				}
				to := id
				bucket.Edges = append(bucket.Edges, edgeRow{
					FromID: k.fromID, ToID: &to, ToName: target, Kind: "imports", Resolved: true,
				})
			}
		}
	}
}

// filesInDir lists claimed files directly under dir, sorted for determinism.
func (e *extractor) filesInDir(dir string) []string {
	var out []string
	for f := range e.fileModule {
		if path.Dir(f) == dir {
			out = append(out, f)
		}
	}
	sort.Strings(out)
	return out
}

func (e *extractor) collectEdges() {
	for _, doc := range e.docs {
		bucket := e.results[doc.file]
		e.nameRefs(bucket, doc.id, doc.node)
		if doc.kind == "Ingress" {
			e.ingressRefs(bucket, doc)
		}
		if doc.kind == "Service" {
			e.selectorRefs(bucket, doc)
		}
	}
	e.kustomizeEdges()
}

// ---- SCIP+ emit ----

const monikerScheme = "librarian-k8s"

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

// scipKind: `resource` reuses the Terraform mapping (Object); module → File.
func scipKind(kind string) scippb.SymbolInformation_Kind {
	switch kind {
	case "module":
		return scippb.SymbolInformation_File
	case "resource":
		return scippb.SymbolInformation_Object
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

func (e *extractor) emitEnvelope(files []string) error {
	scipName := map[string]string{}
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
			Language:         "yaml",
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

	e := &extractor{
		root:       root,
		results:    map[string]*result{},
		addrToID:   map[string]string{},
		fileModule: map[string]string{},
		docsByFile: map[string][]string{},
	}

	type fileSrc struct {
		rel string
		src []byte
	}
	var sources []fileSrc
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
		mid := moduleID(rel)
		e.results[rel] = &result{
			File: rel,
			Symbols: []symbolRow{{
				ID: mid, Kind: "module", Name: rel, File: rel,
				SpanStart: 1, SpanEnd: countLines(srcBytes),
			}},
			Edges: []edgeRow{},
		}
		e.fileModule[rel] = mid
		if srcBytes != nil {
			sources = append(sources, fileSrc{rel, srcBytes})
		}
	}

	// pass 1: symbols (the address table must be repo-complete before pass 2)
	for _, s := range sources {
		e.collectFile(s.rel, s.src)
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

func capabilities() error {
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"protocol":        "librarian-scip-plus",
		"protocolVersion": 1,
		"name":            monikerScheme,
		"extensions":      []string{".yaml", ".yml"},
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
