// librarian-gradle-extractor — the Gradle build-graph implementation of the
// Extractor seam (issue #38, ADR-2 multi-language path; ADR-7 plugin protocol).
//
// This is deliberately a SYNTAX-LEVEL extractor, not the Gradle Tooling API:
// the Tooling API is the official implementation but *evaluates the build*
// (plugin resolution, dependency downloads, arbitrary script execution) —
// non-deterministic across runs and environments, which the determinism
// invariant cannot absorb (the ADR-2 tension issue #38 asked to judge first;
// recorded in dlog). The declarative subset that matters for the build graph
// — settings `include`, `project(":x")` dependencies, task declarations and
// `dependsOn`, plugin ids, version-catalog accessors, Maven coordinates — is
// string-literal-level in both the Groovy and Kotlin DSLs, so a line/pattern
// scanner is deterministic and needs no JVM. Everything dynamic (loops,
// computed coordinates, convention plugins) stays honestly resolved=0.
// `gradle/libs.versions.toml` IS parsed exactly (TOML has a real grammar).
//
// Contract is the same SCIP+ envelope as every other leg:
//
//	stdin:  {"root": "/abs/repo", "files": ["/abs/repo/settings.gradle.kts", ...]}
//	stdout: {"scip": <scip.Index, proto3 canonical JSON>, "ext": {...}}
//
// Symbols (no new SymbolKinds; file modules as always):
//
//	project.:app        (kind resource — anchored at app/build.gradle(.kts),
//	                     spanning the file; path derived from the directory)
//	settings            (kind resource — the settings file's own anchor, so
//	                     include edges are seedable)
//	task.deploy         (kind function — explicitly declared tasks only)
//	libs.commons.text   (kind variable — catalog entries, dash/underscore
//	                     keys normalized to Gradle's dot accessor form)
//	libs.plugins.shadow (kind variable — catalog [plugins] entries)
//
// Edges:
//   - settings include → project symbols (imports).
//   - implementation(project(":core")) → project.:core (references).
//   - libs.x usage on dependency-configuration lines / alias(libs.plugins.x)
//     → catalog symbols (references).
//   - dependsOn "x" → task symbols (same file first, then repo-global),
//     attributed to the nearest task context; unknown names resolved=0.
//   - plugin ids and Maven coordinates → imports resolved=0; coordinates drop
//     the version (group:artifact — the same specifier style as image
//     tag-stripping) so a links.json declaration (#35) can bind in-house
//     libraries later. Catalog entries also emit their module coordinate.
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
	"strings"

	"github.com/BurntSushi/toml"
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

// isGradlePath is the claim set (mirrored by the TS leg): *.gradle,
// *.gradle.kts, and the version catalog exactly — claiming all .toml would
// swallow Cargo.toml / pyproject.toml.
func isGradlePath(rel string) bool {
	base := path.Base(rel)
	if strings.HasSuffix(base, ".gradle") || strings.HasSuffix(base, ".gradle.kts") {
		return true
	}
	return base == "libs.versions.toml" && path.Base(path.Dir(rel)) == "gradle"
}

var (
	reInclude    = regexp.MustCompile(`['"](:[A-Za-z0-9:_-]+)['"]`)
	reIncludeLn  = regexp.MustCompile(`^\s*include\b`)
	reRootName   = regexp.MustCompile(`rootProject\.name\s*=\s*['"]([^'"]+)['"]`)
	reProjectRef = regexp.MustCompile(`\bproject\s*\(\s*(?:path\s*[:=]\s*)?['"](:[A-Za-z0-9:_-]+)['"]`)
	reTaskReg    = regexp.MustCompile(`\btasks\.(?:register|create)\s*[( ]\s*['"]([A-Za-z0-9_]+)['"]`)
	reTaskGroovy = regexp.MustCompile(`^\s*task\s+([A-Za-z0-9_]+)\s*[({]`)
	reTaskNamed  = regexp.MustCompile(`\btasks\.named\s*\(\s*['"]([A-Za-z0-9_]+)['"]`)
	reDependsOn  = regexp.MustCompile(`\bdependsOn\b`)
	reQuoted     = regexp.MustCompile(`['"]([^'"]+)['"]`)
	reNamedRef   = regexp.MustCompile(`\bnamed\s*\(\s*['"]([A-Za-z0-9_]+)['"]`)
	rePluginID   = regexp.MustCompile(`\bid\s*[( ]\s*['"]([A-Za-z0-9_.-]+)['"]`)
	reKotlinPlug = regexp.MustCompile(`\bkotlin\s*\(\s*['"]([a-z0-9.-]+)['"]`)
	reApplyPlug  = regexp.MustCompile(`\bapply\s+plugin\s*:\s*['"]([A-Za-z0-9_.-]+)['"]`)
	reAlias      = regexp.MustCompile(`\balias\s*\(\s*libs\.plugins\.([A-Za-z0-9_.]+)`)
	reLibsRef    = regexp.MustCompile(`\blibs\.((?:[A-Za-z0-9_]+\.)*[A-Za-z0-9_]+)`)
	reConfigLine = regexp.MustCompile(`^\s*(implementation|api|compileOnly|compileOnlyApi|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor|kapt|ksp|classpath|developmentOnly|integrationTestImplementation)\b`)
	reCoordinate = regexp.MustCompile(`^([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?::[^:'"]+)?$`)
	reLineChomp  = regexp.MustCompile(`^\s*//`)
)

// accessor normalizes a catalog key to the dot accessor Gradle generates:
// "commons-text" → "commons.text".
func accessor(key string) string {
	return strings.NewReplacer("-", ".", "_", ".").Replace(key)
}

type extractor struct {
	root    string
	results map[string]*result
	claimed map[string]bool
	// project path (":app") -> symbol id, task name -> id (per file + global),
	// catalog accessor ("commons.text" / "plugins.shadow") -> id
	projects    map[string]string
	tasksByFile map[string]map[string]string
	tasksGlobal map[string]string
	catalog     map[string]string
	// deferred per-file scans (pass 2 needs complete tables)
	buildFiles    []string
	settingsFiles []string
	sources       map[string][]string
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

func (e *extractor) addEdge(file, fromID string, toID *string, toName, kind string) {
	e.results[file].Edges = append(e.results[file].Edges, edgeRow{
		FromID: fromID, ToID: toID, ToName: toName, Kind: kind, Resolved: toID != nil,
	})
}

// projectPath derives the Gradle project path from a build file's directory:
// app/build.gradle.kts → ":app", services/api → ":services:api", root → ":".
func projectPath(rel string) string {
	dir := path.Dir(rel)
	if dir == "." {
		return ":"
	}
	return ":" + strings.ReplaceAll(dir, "/", ":")
}

// ---- pass 1: symbols ----

func (e *extractor) collectBuildSymbols(rel string) {
	lines := e.sources[rel]
	pp := projectPath(rel)
	// kind resource, not module: retrieval seeds documents by span overlap and
	// treats module-kind symbols as fallback only (the #39 Kustomization
	// lesson) — and a project is a declared build unit, the same concept.
	projID := e.addSymbol(rel, "project."+pp, "resource", 1, len(lines))
	if _, ok := e.projects[pp]; !ok {
		e.projects[pp] = projID
	}
	e.tasksByFile[rel] = map[string]string{}
	for i, line := range lines {
		if reLineChomp.MatchString(line) {
			continue
		}
		var names []string
		for _, m := range reTaskReg.FindAllStringSubmatch(line, -1) {
			names = append(names, m[1])
		}
		if m := reTaskGroovy.FindStringSubmatch(line); m != nil {
			names = append(names, m[1])
		}
		for _, name := range names {
			id := e.addSymbol(rel, "task."+name, "function", i+1, i+1)
			e.tasksByFile[rel][name] = id
			if _, ok := e.tasksGlobal[name]; !ok {
				e.tasksGlobal[name] = id
			}
		}
	}
}

func (e *extractor) collectSettingsSymbols(rel string) {
	lines := e.sources[rel]
	name := "settings"
	if dir := path.Dir(rel); dir != "." {
		name = "settings." + strings.ReplaceAll(dir, "/", ":")
	}
	e.addSymbol(rel, name, "resource", 1, len(lines))
}

// catalogSymbols parses gradle/libs.versions.toml exactly.
func (e *extractor) collectCatalog(rel string) {
	var doc struct {
		Libraries map[string]toml.Primitive `toml:"libraries"`
		Plugins   map[string]toml.Primitive `toml:"plugins"`
	}
	text := strings.Join(e.sources[rel], "\n")
	meta, err := toml.Decode(text, &doc)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warn: %s: %v\n", rel, err)
		return
	}
	lineOf := func(section, key string) int {
		// best-effort: find the key at line start within the file
		re := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(key) + `\s*=`)
		inSection := false
		for i, l := range e.sources[rel] {
			trimmed := strings.TrimSpace(l)
			if strings.HasPrefix(trimmed, "[") {
				inSection = trimmed == "["+section+"]"
				continue
			}
			if inSection && re.MatchString(l) {
				return i + 1
			}
		}
		return 1
	}
	type entry struct {
		key, name, kind string
		coordinate      string // "group:artifact" or plugin id, "" when dynamic
	}
	var entries []entry
	for key := range doc.Libraries {
		var lib struct {
			Module  string `toml:"module"`
			Group   string `toml:"group"`
			Name    string `toml:"name"`
			Version toml.Primitive
		}
		_ = meta.PrimitiveDecode(doc.Libraries[key], &lib)
		coord := lib.Module
		if coord == "" && lib.Group != "" && lib.Name != "" {
			coord = lib.Group + ":" + lib.Name
		}
		entries = append(entries, entry{key, "libs." + accessor(key), "libraries", coord})
	}
	for key := range doc.Plugins {
		var plug struct {
			ID string `toml:"id"`
		}
		_ = meta.PrimitiveDecode(doc.Plugins[key], &plug)
		entries = append(entries, entry{key, "libs.plugins." + accessor(key), "plugins", plug.ID})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].name < entries[j].name })
	for _, en := range entries {
		line := lineOf(en.kind, en.key)
		id := e.addSymbol(rel, en.name, "variable", line, line)
		e.catalog[strings.TrimPrefix(en.name, "libs.")] = id
		if en.coordinate != "" {
			// the catalog entry points at its external coordinate — the #35
			// specifier a links.json declaration can bind.
			e.addEdge(rel, id, nil, en.coordinate, "imports")
		}
	}
}

// ---- pass 2: edges ----

func (e *extractor) settingsEdges(rel string) {
	lines := e.sources[rel]
	fromID := e.results[rel].Symbols[1].ID // the settings symbol (module row is [0])
	for _, line := range lines {
		if reLineChomp.MatchString(line) || !reIncludeLn.MatchString(line) {
			continue
		}
		for _, m := range reInclude.FindAllStringSubmatch(line, -1) {
			pp := m[1]
			if id, ok := e.projects[pp]; ok {
				to := id
				e.addEdge(rel, fromID, &to, pp, "imports")
			} else {
				e.addEdge(rel, fromID, nil, pp, "imports")
			}
		}
	}
}

func (e *extractor) buildEdges(rel string) {
	lines := e.sources[rel]
	projID := e.projects[projectPath(rel)]
	fileTasks := e.tasksByFile[rel]
	taskCtx := "" // the nearest task context (register/create/task/named)

	seenPlugin := map[string]bool{}
	pluginEdge := func(id string) {
		if id == "" || seenPlugin[id] {
			return
		}
		seenPlugin[id] = true
		e.addEdge(rel, projID, nil, id, "imports")
	}

	for _, line := range lines {
		if reLineChomp.MatchString(line) {
			continue
		}
		// task contexts
		if m := reTaskReg.FindStringSubmatch(line); m != nil {
			taskCtx = m[1]
		} else if m := reTaskGroovy.FindStringSubmatch(line); m != nil {
			taskCtx = m[1]
		} else if m := reTaskNamed.FindStringSubmatch(line); m != nil {
			taskCtx = m[1]
		}

		// project(":x") references
		for _, m := range reProjectRef.FindAllStringSubmatch(line, -1) {
			pp := m[1]
			if id, ok := e.projects[pp]; ok && id != projID {
				to := id
				e.addEdge(rel, projID, &to, pp, "references")
			} else if !ok {
				e.addEdge(rel, projID, nil, pp, "references")
			}
		}

		// plugins
		for _, m := range rePluginID.FindAllStringSubmatch(line, -1) {
			pluginEdge(m[1])
		}
		for _, m := range reKotlinPlug.FindAllStringSubmatch(line, -1) {
			pluginEdge("org.jetbrains.kotlin." + m[1])
		}
		for _, m := range reApplyPlug.FindAllStringSubmatch(line, -1) {
			pluginEdge(m[1])
		}
		for _, m := range reAlias.FindAllStringSubmatch(line, -1) {
			key := "plugins." + m[1]
			if id, ok := e.catalog[key]; ok {
				to := id
				e.addEdge(rel, projID, &to, "libs."+key, "references")
			} else {
				e.addEdge(rel, projID, nil, "libs."+key, "references")
			}
		}

		// dependsOn — attributed to the nearest task context
		if reDependsOn.MatchString(line) {
			fromID := projID
			if taskCtx != "" {
				if id, ok := fileTasks[taskCtx]; ok {
					fromID = id
				}
			}
			after := line[strings.Index(line, "dependsOn"):]
			var refs []string
			for _, m := range reQuoted.FindAllStringSubmatch(after, -1) {
				refs = append(refs, m[1])
			}
			for _, m := range reNamedRef.FindAllStringSubmatch(after, -1) {
				refs = append(refs, m[1])
			}
			for _, name := range refs {
				id, ok := fileTasks[name]
				if !ok {
					id, ok = e.tasksGlobal[name]
				}
				if ok && id != fromID {
					to := id
					e.addEdge(rel, fromID, &to, "task."+name, "references")
				} else if !ok {
					e.addEdge(rel, fromID, nil, name, "references")
				}
			}
			continue // a dependsOn line is not a dependency-configuration line
		}

		// dependency configurations: coordinates + catalog accessors
		if reConfigLine.MatchString(line) {
			for _, m := range reQuoted.FindAllStringSubmatch(line, -1) {
				if c := reCoordinate.FindStringSubmatch(m[1]); c != nil {
					e.addEdge(rel, projID, nil, c[1]+":"+c[2], "imports")
				}
			}
			for _, m := range reLibsRef.FindAllStringSubmatch(line, -1) {
				key := m[1]
				if strings.HasPrefix(key, "versions.") || strings.HasPrefix(key, "bundles.") ||
					strings.HasPrefix(key, "plugins.") {
					continue
				}
				if id, ok := e.catalog[key]; ok && id != projID {
					to := id
					e.addEdge(rel, projID, &to, "libs."+key, "references")
				} else if !ok {
					e.addEdge(rel, projID, nil, "libs."+key, "references")
				}
			}
		}
	}
}

// ---- SCIP+ emit ----

const monikerScheme = "librarian-gradle"

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

func scipKind(kind string) scippb.SymbolInformation_Kind {
	switch kind {
	case "module":
		return scippb.SymbolInformation_File
	case "resource":
		return scippb.SymbolInformation_Object
	case "function":
		return scippb.SymbolInformation_Function
	case "variable":
		return scippb.SymbolInformation_Variable
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
			Language:         "gradle",
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
		root:        root,
		results:     map[string]*result{},
		claimed:     map[string]bool{},
		projects:    map[string]string{},
		tasksByFile: map[string]map[string]string{},
		tasksGlobal: map[string]string{},
		catalog:     map[string]string{},
		sources:     map[string][]string{},
	}

	var catalogFiles []string
	for _, f := range req.Files {
		abs := f
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(root, abs)
		}
		rel := e.rel(abs)
		e.claimed[rel] = true
		srcBytes, rerr := os.ReadFile(abs)
		if rerr != nil {
			fmt.Fprintf(os.Stderr, "warn: %s: %v\n", rel, rerr)
			srcBytes = nil
		}
		text := string(srcBytes)
		lines := strings.Split(text, "\n")
		if text == "" {
			lines = []string{""}
		} else if strings.HasSuffix(text, "\n") {
			lines = lines[:len(lines)-1]
		}
		e.sources[rel] = lines
		e.results[rel] = &result{
			File: rel,
			Symbols: []symbolRow{{
				ID: moduleID(rel), Kind: "module", Name: rel, File: rel,
				SpanStart: 1, SpanEnd: len(lines),
			}},
			Edges: []edgeRow{},
		}
		base := path.Base(rel)
		switch {
		case base == "settings.gradle" || base == "settings.gradle.kts":
			e.settingsFiles = append(e.settingsFiles, rel)
		case base == "libs.versions.toml":
			catalogFiles = append(catalogFiles, rel)
		case strings.HasSuffix(base, ".gradle") || strings.HasSuffix(base, ".gradle.kts"):
			e.buildFiles = append(e.buildFiles, rel)
		}
	}
	sort.Strings(e.buildFiles)
	sort.Strings(e.settingsFiles)
	sort.Strings(catalogFiles)

	// pass 1: symbols (project/task/catalog tables must be complete first)
	for _, rel := range e.buildFiles {
		e.collectBuildSymbols(rel)
	}
	for _, rel := range e.settingsFiles {
		e.collectSettingsSymbols(rel)
	}
	for _, rel := range catalogFiles {
		e.collectCatalog(rel)
	}
	// pass 2: edges
	for _, rel := range e.settingsFiles {
		e.settingsEdges(rel)
	}
	for _, rel := range e.buildFiles {
		e.buildEdges(rel)
	}

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

// capabilities answers the plugin-protocol handshake (issue #22 / ADR-7).
// `basenames` announces the extension-less claims (issue #40 precedent).
func capabilities() error {
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"protocol":        "librarian-scip-plus",
		"protocolVersion": 1,
		"name":            monikerScheme,
		"extensions":      []string{".gradle", ".gradle.kts"},
		"basenames":       []string{"gradle/libs.versions.toml"},
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
