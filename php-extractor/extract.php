<?php

declare(strict_types=1);

/**
 * librarian php-extractor — the PHP implementation of the Extractor seam
 * (src/extractor.ts, architecture §4-①, ADR-2 multi-language path).
 *
 * librarian spawns `php extract.php` as a child process. Contract (SCIP+
 * envelope, issue #16 / docs/scip-design.md §4):
 *
 *   stdin:  {"root": "/abs/repo", "files": ["/abs/repo/a.php", ...]}
 *   stdout: {"scip": <scip.Index, proto3 canonical JSON>, "ext": {...}}
 *
 * The scip half is a standards-compliant SCIP index (hand-built JSON — no
 * protobuf dependency in PHP, by design). The ext half carries what SCIP
 * cannot express: the edge taxonomy, unresolved references, and testblocks
 * as first-class symbols. Ingest (src/scip-ingest.ts) treats ext as the
 * source of truth for edges. Ranges are line-accurate only (php-parser's
 * default attributes carry no columns), emitted as empty ranges at the
 * name's line — legal SCIP.
 *
 * Parsing is nikic/php-parser (the base PHPStan and Psalm are built on —
 * issue #8's first candidate) with its NameResolver visitor, so namespace +
 * `use` resolution (PHP's PSR-4 name story) is first-class. Static edges
 * that land on a symbol declared in a claimed file are stored resolved;
 * everything else — vendor code, the standard library, and inherently
 * dynamic dispatch (`$obj->$method()`, variable/`new $class`, magic methods)
 * — is kept with resolved=false and the name as written. Completeness is
 * sacrificed, measurability is not (same policy as the TS and Go extractors).
 *
 * Symbol ids reuse librarian's scheme — sha256(file::container::name::kind)
 * hex-truncated to 20 — so rows from every language coexist in one store.
 */

require __DIR__ . '/vendor/autoload.php';

use PhpParser\Node;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\NameResolver;
use PhpParser\ParserFactory;

/** must match src/indexer.ts symbolId: sha256(file::container::name::kind)[:20] */
function symbol_id(string $file, ?string $container, string $name, string $kind): string
{
    return substr(hash('sha256', $file . '::' . ($container ?? '') . '::' . $name . '::' . $kind), 0, 20);
}

/** normalize an FQN to librarian's key form: no leading backslash */
function fqn(string $name): string
{
    return ltrim($name, '\\');
}

// ---- SCIP+ emit helpers (issue #16, docs/scip-design.md §4.2) ----

const MONIKER_SCHEME = 'librarian-php';

function escape_ident(string $name): string
{
    if ($name !== '' && preg_match('/^[A-Za-z0-9_+$-]+$/', $name) === 1) {
        return $name;
    }
    return '`' . str_replace('`', '``', $name) . '`';
}

/**
 * moniker: file as namespace descriptor, container chain (always a class-like
 * in PHP → '#'), then self. The package part stays empty — monikers never
 * carry the repo dimension.
 *
 * @param array{kind:string,name:string,file:string,container:?string} $row
 */
function moniker(array $row): string
{
    $head = MONIKER_SCHEME . ' . . . ' . escape_ident($row['file']) . '/';
    if ($row['kind'] === 'module') {
        return $head;
    }
    if ($row['container'] !== null) {
        foreach (explode('.', $row['container']) as $seg) {
            $head .= escape_ident($seg) . '#';
        }
    }
    return match ($row['kind']) {
        'function', 'method' => $head . escape_ident($row['name']) . '().',
        'class', 'interface', 'trait', 'enum' => $head . escape_ident($row['name']) . '#',
        default => $head . escape_ident($row['name']) . '.', // typealias, variable
    };
}

/** SymbolInformation.Kind enum name, or null for testblock (ext is its truth). */
function scip_kind(string $kind): ?string
{
    return match ($kind) {
        'module' => 'File',
        'function' => 'Function',
        'method' => 'Method',
        'class' => 'Class',
        'interface' => 'Interface',
        'trait' => 'Trait',
        'enum' => 'Enum',
        'variable' => 'Variable',
        default => null,
    };
}

/**
 * One extraction run. Two passes over every claimed file: pass 1 registers
 * declared symbols (building the FQN → symbol tables pass 2 resolves against),
 * pass 2 emits edges. Cross-file resolution is why extraction is whole-project.
 */
final class Extractor
{
    /** CakePHP: a route with a controller but no action defaults to `index` (#43). */
    private const DEFAULT_ACTION = 'index';

    private string $root;
    /** @var array<string,bool> rel path => claimed */
    private array $claimed = [];
    /** @var array<string,array{file:string,symbols:array,edges:array}> rel => bucket */
    private array $results = [];
    /** @var array<string,Node\Stmt[]> rel => parsed AST */
    private array $asts = [];

    /** registered symbol spans per file, for innermost-enclosing lookups */
    /** @var array<string,array<array{id:string,start:int,end:int}>> */
    private array $symsIn = [];

    /** @var array<string,array{file:string,short:string,id:string,parent:?string}> class FQN => decl */
    private array $classByFqn = [];
    /** @var array<string,string> function FQN => symbol id */
    private array $funcByFqn = [];
    /** @var array<string,array<string,string>> class FQN => (method name => symbol id) */
    private array $methodsByClassFqn = [];
    /** @var array<string,string> declaring file (rel) of a class FQN */
    private array $fileOfClassFqn = [];
    /** @var array<string,string> testblock id => owning class symbol id (for enclosing_symbol) */
    private array $tbParent = [];

    public function __construct(string $root)
    {
        $this->root = rtrim($root, '/');
    }

    private function rel(string $abs): string
    {
        $abs = str_replace('\\', '/', $abs);
        if (str_starts_with($abs, $this->root . '/')) {
            return substr($abs, strlen($this->root) + 1);
        }
        return $abs;
    }

    private function moduleId(string $file): string
    {
        return symbol_id($file, null, $file, 'module');
    }

    private function register(string $file, string $id, int $start, int $end): void
    {
        $this->symsIn[$file][] = ['id' => $id, 'start' => $start, 'end' => $end];
    }

    /** innermost registered symbol containing $line; the file module when none. */
    private function enclosing(string $file, int $line): string
    {
        $best = $this->moduleId($file);
        $bestSpan = PHP_INT_MAX;
        foreach ($this->symsIn[$file] ?? [] as $s) {
            if ($s['start'] <= $line && $line <= $s['end'] && ($s['end'] - $s['start']) < $bestSpan) {
                $best = $s['id'];
                $bestSpan = $s['end'] - $s['start'];
            }
        }
        return $best;
    }

    public function run(array $files): array
    {
        $parser = (new ParserFactory())->createForNewestSupportedVersion();

        foreach ($files as $abs) {
            if (!str_starts_with($abs, '/')) {
                $abs = $this->root . '/' . $abs;
            }
            $rel = $this->rel($abs);
            $this->claimed[$rel] = true;
            $code = @file_get_contents($abs);
            if ($code === false) {
                $code = '';
            }
            $lines = max(1, substr_count($code, "\n") + (str_ends_with($code, "\n") || $code === '' ? 0 : 1));
            // every claimed file gets at least its file-level module symbol, so a
            // file that fails to parse still exists in the store and diff seeding
            // can fall back to it (degrade, don't block).
            $this->results[$rel] = [
                'file' => $rel,
                'symbols' => [[
                    'id' => $this->moduleId($rel),
                    'kind' => 'module',
                    'name' => $rel,
                    'file' => $rel,
                    'container' => null,
                    'spanStart' => 1,
                    'spanEnd' => $lines,
                    'signature' => null,
                    'doc' => null,
                ]],
                'edges' => [],
            ];

            try {
                $stmts = $parser->parse($code);
            } catch (\Throwable $e) {
                fwrite(STDERR, "warn: parse failed for {$rel}: {$e->getMessage()}\n");
                $stmts = null;
            }
            if ($stmts === null) {
                continue;
            }
            // NameResolver rewrites every class/interface/trait reference to its
            // fully-qualified form and stamps namespacedName on declarations, so
            // both passes see resolved names without re-implementing PSR-4.
            $traverser = new NodeTraverser();
            $traverser->addVisitor(new NameResolver());
            $this->asts[$rel] = $traverser->traverse($stmts);
        }

        foreach ($this->asts as $rel => $stmts) {
            $this->collectSymbols($rel, $stmts, null, '');
        }
        foreach ($this->asts as $rel => $stmts) {
            $this->collectEdges($rel, $stmts, null, '');
        }

        foreach ($this->results as $rel => $bucket) {
            $this->results[$rel]['edges'] = $this->dedupeEdges($bucket['edges']);
        }
        return $this->emitEnvelope();
    }

    // ---- SCIP+ emit (issue #16, docs/scip-design.md §4) ----

    /** @return array{scip:array,ext:array} the SCIP+ envelope, ready for json_encode */
    private function emitEnvelope(): array
    {
        // scip symbol string (moniker, or a document-local id for testblocks)
        // per symbol id; locals are numbered in collection order.
        $scipName = [];
        $fileOfId = [];
        foreach ($this->results as $rel => $bucket) {
            $local = 0;
            foreach ($bucket['symbols'] as $row) {
                $fileOfId[$row['id']] = $rel;
                if ($row['kind'] === 'testblock') {
                    $scipName[$row['id']] = 'local ' . $local;
                    $local++;
                } else {
                    $scipName[$row['id']] = moniker($row);
                }
            }
        }

        $documents = [];
        $extDocs = [];
        foreach ($this->results as $rel => $bucket) {
            $occurrences = [];
            $symbols = [];
            $extSymbols = [];
            $extEdges = [];

            foreach ($bucket['symbols'] as $row) {
                $sym = $scipName[$row['id']];
                $roles = 1; // Definition
                if ($row['kind'] === 'testblock') {
                    $roles |= 32; // Test
                }
                $occurrences[] = [
                    'symbol' => $sym,
                    'symbolRoles' => $roles,
                    // empty range at the name's line: default php-parser attributes carry no columns
                    'singleLineRange' => ['line' => ($row['nameLine'] ?? $row['spanStart']) - 1],
                    'multiLineEnclosingRange' => ['startLine' => $row['spanStart'] - 1, 'endLine' => $row['spanEnd']],
                ];

                $info = ['symbol' => $sym, 'displayName' => $row['name']];
                $kindName = scip_kind($row['kind']);
                if ($kindName !== null) {
                    $info['kind'] = $kindName;
                }
                if ($row['doc'] !== null) {
                    $info['documentation'] = [$row['doc']];
                }
                if ($row['signature'] !== null) {
                    $info['signatureDocumentation'] = ['language' => 'php', 'text' => $row['signature']];
                }
                if ($row['kind'] === 'testblock') {
                    $parent = $this->tbParent[$row['id']] ?? null;
                    if ($parent !== null && isset($scipName[$parent])) {
                        $info['enclosingSymbol'] = $scipName[$parent];
                    }
                    $extSymbols[] = [
                        'symbol' => $sym,
                        'kind' => $row['kind'],
                        'name' => $row['name'],
                        'container' => $row['container'],
                        'spanStart' => $row['spanStart'],
                        'spanEnd' => $row['spanEnd'],
                    ];
                }
                $relationships = [];
                foreach ($bucket['edges'] as $edge) {
                    if ($edge['kind'] === 'extends' && $edge['fromId'] === $row['id'] && $edge['toId'] !== null && isset($scipName[$edge['toId']])) {
                        $relationships[] = ['symbol' => $scipName[$edge['toId']], 'isImplementation' => true];
                    }
                }
                if ($relationships !== []) {
                    $info['relationships'] = $relationships;
                }
                $symbols[] = $info;
            }

            // edges: all go to ext (the source of truth); resolved
            // calls/references/imports also project to base occurrences.
            foreach ($bucket['edges'] as $edge) {
                $from = $scipName[$edge['fromId']];
                $to = null;
                if ($edge['toId'] !== null && isset($scipName[$edge['toId']])) {
                    $t = $scipName[$edge['toId']];
                    if (str_starts_with($t, 'local ') && ($fileOfId[$edge['toId']] ?? $rel) !== $rel) {
                        fwrite(STDERR, "warn: {$rel}: dropping cross-file edge into a test block\n");
                    } else {
                        $to = $t;
                    }
                }
                $extEdges[] = [
                    'from' => $from,
                    'to' => $to,
                    'toName' => $edge['toName'],
                    'kind' => $edge['kind'],
                    'resolved' => $to !== null,
                ];
                if ($to === null || $edge['kind'] === 'extends' || $edge['refLine'] === null) {
                    continue;
                }
                $occ = [
                    'symbol' => $to,
                    'singleLineRange' => ['line' => $edge['refLine'] - 1],
                ];
                if ($edge['kind'] === 'imports') {
                    $occ['symbolRoles'] = 2; // Import
                }
                $occurrences[] = $occ;
            }

            $documents[] = [
                'language' => 'php',
                'relativePath' => $rel,
                'positionEncoding' => 'UTF8CodeUnitOffsetFromLineStart',
                'occurrences' => $occurrences,
                'symbols' => $symbols,
            ];
            $extDocs[] = ['relativePath' => $rel, 'symbols' => $extSymbols, 'edges' => $extEdges];
        }

        return [
            'scip' => [
                'metadata' => [
                    'toolInfo' => ['name' => MONIKER_SCHEME, 'version' => '0.1.0'],
                    'projectRoot' => 'file://' . $this->root,
                    'textDocumentEncoding' => 'UTF8',
                ],
                'documents' => $documents,
            ],
            'ext' => ['version' => 1, 'documents' => $extDocs],
        ];
    }

    // ---- pass 1: symbols ----

    private function addSymbol(string $file, string $id, string $kind, string $name, ?string $container, int $start, int $end, ?string $sig, ?string $doc, ?int $nameLine = null): void
    {
        $this->results[$file]['symbols'][] = [
            'id' => $id,
            'kind' => $kind,
            'name' => $name,
            'file' => $file,
            'container' => $container,
            'spanStart' => $start,
            'spanEnd' => $end,
            'signature' => $sig,
            'doc' => $doc,
            'nameLine' => $nameLine, // internal: definition-occurrence line (emit strips it)
        ];
        $this->register($file, $id, $start, $end);
    }

    /** recurse into namespaces; declare functions/classes/interfaces/traits/enums/consts. */
    private function collectSymbols(string $file, array $stmts, ?string $ns, string $_container): void
    {
        foreach ($stmts as $stmt) {
            if ($stmt instanceof Node\Stmt\Namespace_) {
                $nsName = $stmt->name ? $stmt->name->toString() : null;
                // the module symbol carries `namespace X` the way Go's carries `package X`
                if ($nsName !== null && $this->results[$file]['symbols'][0]['signature'] === null) {
                    $this->results[$file]['symbols'][0]['signature'] = 'namespace ' . $nsName;
                }
                $this->collectSymbols($file, $stmt->stmts, $nsName, $_container);
                continue;
            }
            if ($stmt instanceof Node\Stmt\Function_) {
                $name = $stmt->name->toString();
                $fq = fqn($stmt->namespacedName ? $stmt->namespacedName->toString() : $name);
                $id = symbol_id($file, null, $name, 'function');
                $this->funcByFqn[$fq] = $id;
                $this->addSymbol($file, $id, 'function', $name, null, $stmt->getStartLine(), $stmt->getEndLine(), $this->funcSignature($stmt), $this->docText($stmt), $stmt->name->getStartLine());
                continue;
            }
            if ($stmt instanceof Node\Stmt\ClassLike) {
                $this->collectClassLike($file, $stmt);
                continue;
            }
            if ($stmt instanceof Node\Stmt\Const_) {
                foreach ($stmt->consts as $c) {
                    $name = $c->name->toString();
                    $id = symbol_id($file, null, $name, 'variable');
                    $this->addSymbol($file, $id, 'variable', $name, null, $stmt->getStartLine(), $stmt->getEndLine(), null, null, $c->name->getStartLine());
                }
                continue;
            }
        }
    }

    private function collectClassLike(string $file, Node\Stmt\ClassLike $node): void
    {
        $short = $node->name ? $node->name->toString() : '{anonymous}';
        $fq = fqn($node->namespacedName ? $node->namespacedName->toString() : $short);
        $kind = match (true) {
            $node instanceof Node\Stmt\Interface_ => 'interface',
            $node instanceof Node\Stmt\Trait_ => 'trait',
            $node instanceof Node\Stmt\Enum_ => 'enum',
            default => 'class',
        };
        $parent = null;
        if ($node instanceof Node\Stmt\Class_ && $node->extends) {
            $parent = fqn($node->extends->toString());
        }
        $id = symbol_id($file, null, $short, $kind);
        $this->classByFqn[$fq] = ['file' => $file, 'short' => $short, 'id' => $id, 'parent' => $parent];
        $this->fileOfClassFqn[$fq] = $file;
        $this->methodsByClassFqn[$fq] = [];
        $this->addSymbol($file, $id, $kind, $short, null, $node->getStartLine(), $node->getEndLine(), null, $this->docText($node), $node->name?->getStartLine());

        foreach ($node->stmts as $member) {
            if ($member instanceof Node\Stmt\ClassMethod) {
                $mname = $member->name->toString();
                $mkind = $this->isTestMethod($member) ? 'testblock' : 'method';
                $mid = symbol_id($file, $short, $mname, $mkind);
                $this->methodsByClassFqn[$fq][$mname] = $mid;
                if ($mkind === 'testblock') {
                    $this->tbParent[$mid] = $id;
                }
                $this->addSymbol($file, $mid, $mkind, $mname, $short, $member->getStartLine(), $member->getEndLine(), $this->funcSignature($member), $this->docText($member), $member->name->getStartLine());
            }
        }
    }

    /** PHPUnit test blocks: a `#[Test]` attribute or the `test*` method convention. */
    private function isTestMethod(Node\Stmt\ClassMethod $m): bool
    {
        foreach ($m->attrGroups as $group) {
            foreach ($group->attrs as $attr) {
                $n = strtolower($attr->name->toString());
                if ($n === 'test' || str_ends_with($n, '\\test')) {
                    return true;
                }
            }
        }
        return (bool) preg_match('/^test[A-Z0-9_]/', $m->name->toString());
    }

    // ---- pass 2: edges ----

    /**
     * Name a use site by the package it came from when the target lives outside
     * this repo — `<namespace-prefix>#<ShortName>` (#35, docs/plugin-protocol.md
     * §8.1). NameResolver has already fully-qualified the reference, so the
     * namespace prefix is the specifier and the last segment is the imported
     * name. A global-namespace name (no `\`) has no specifier and stays raw:
     * the invariant is no false edges, not completeness.
     */
    private function externalBinding(string $raw): ?string
    {
        $fq = fqn($raw);
        $pos = strrpos($fq, '\\');
        if ($pos === false) {
            return null;
        }
        return substr($fq, 0, $pos) . '#' . substr($fq, $pos + 1);
    }

    private function addEdge(string $file, string $fromId, ?string $toId, string $toName, string $kind, ?int $refLine = null): void
    {
        if ($toId !== null && $toId === $fromId) {
            return; // self loops are noise
        }
        $this->results[$file]['edges'][] = [
            'fromId' => $fromId,
            'toId' => $toId,
            'toName' => $toName,
            'kind' => $kind,
            'resolved' => $toId !== null,
            'refLine' => $refLine, // internal: reference-occurrence line (emit strips it)
        ];
    }

    private function collectEdges(string $file, array $stmts, ?string $ns, ?string $classFqn): void
    {
        $moduleId = $this->moduleId($file);
        foreach ($stmts as $stmt) {
            if ($stmt instanceof Node\Stmt\Namespace_) {
                $this->collectEdges($file, $stmt->stmts, $stmt->name ? $stmt->name->toString() : null, null);
                continue;
            }
            if ($stmt instanceof Node\Stmt\Use_ || $stmt instanceof Node\Stmt\GroupUse) {
                $this->collectUse($file, $moduleId, $stmt);
                continue;
            }
            if ($stmt instanceof Node\Stmt\ClassLike) {
                $this->collectClassEdges($file, $ns, $stmt);
                continue;
            }
            if ($stmt instanceof Node\Stmt\Function_) {
                $this->walkCallable($file, $ns, null, null, $stmt);
                continue;
            }
        }
    }

    private function collectUse($file, string $moduleId, Node\Stmt $use): void
    {
        $prefix = ($use instanceof Node\Stmt\GroupUse) ? $use->prefix->toString() . '\\' : '';
        $uses = ($use instanceof Node\Stmt\GroupUse) ? $use->uses : $use->uses;
        foreach ($uses as $u) {
            $target = fqn($prefix . $u->name->toString());
            $toFile = $this->fileOfClassFqn[$target] ?? null;
            if ($toFile === null && isset($this->funcByFqn[$target])) {
                // `use function` of a repo function → its declaring file module
                foreach ($this->results as $rel => $b) {
                    foreach ($b['symbols'] as $s) {
                        if ($s['id'] === $this->funcByFqn[$target]) {
                            $toFile = $rel;
                            break 2;
                        }
                    }
                }
            }
            $toId = $toFile !== null ? $this->moduleId($toFile) : null;
            $this->addEdge($file, $moduleId, $toId, $target, 'imports', $u->getStartLine());
            // external `use` (#35 §8.1): also emit the `<ns>#<Name>` binding so
            // `librarian link` can resolve the import itself, not just use sites.
            if ($toId === null) {
                $ext = $this->externalBinding($target);
                if ($ext !== null) {
                    $this->addEdge($file, $moduleId, null, $ext, 'imports', $u->getStartLine());
                }
            }
        }
    }

    private function collectClassEdges(string $file, ?string $ns, Node\Stmt\ClassLike $node): void
    {
        $short = $node->name ? $node->name->toString() : '{anonymous}';
        $fq = fqn($node->namespacedName ? $node->namespacedName->toString() : $short);
        $fromId = $this->classByFqn[$fq]['id'] ?? $this->enclosing($file, $node->getStartLine());

        // extends / implements / interface-extends → extends edges
        $supers = [];
        if ($node instanceof Node\Stmt\Class_) {
            if ($node->extends) {
                $supers[] = $node->extends;
            }
            foreach ($node->implements as $i) {
                $supers[] = $i;
            }
        } elseif ($node instanceof Node\Stmt\Interface_) {
            foreach ($node->extends as $e) {
                $supers[] = $e;
            }
        } elseif ($node instanceof Node\Stmt\Enum_) {
            foreach ($node->implements as $i) {
                $supers[] = $i;
            }
        }
        foreach ($supers as $name) {
            $this->addTypeEdge($file, $fromId, $name, 'extends');
        }

        foreach ($node->stmts as $member) {
            if ($member instanceof Node\Stmt\TraitUse) {
                // `use SomeTrait;` in a class body — composition modeled as extends
                foreach ($member->traits as $t) {
                    $this->addTypeEdge($file, $fromId, $t, 'extends');
                }
                continue;
            }
            if ($member instanceof Node\Stmt\Property) {
                // property type hint → references from the owning class
                $this->addTypeReferences($file, $fromId, $member->type);
                continue;
            }
            if ($member instanceof Node\Stmt\ClassMethod) {
                $mkind = $this->isTestMethod($member) ? 'testblock' : 'method';
                $mid = symbol_id($file, $short, $member->name->toString(), $mkind);
                $this->walkCallable($file, $ns, $fq, $mid, $member);
            }
        }
    }

    /** a Function_/ClassMethod body + signature: calls, `new`, references. */
    private function walkCallable(string $file, ?string $ns, ?string $classFqn, ?string $selfId, Node\FunctionLike $fn): void
    {
        // signature type hints as references, attributed to the callable symbol
        $selfId = $selfId ?? $this->enclosing($file, $fn->getStartLine());
        foreach ($fn->getParams() as $p) {
            $this->addTypeReferences($file, $selfId, $p->type);
        }
        $this->addTypeReferences($file, $selfId, $fn->getReturnType());

        if ($fn->getStmts() === null) {
            return;
        }
        $this->walkExprs($file, $ns, $classFqn, $fn->getStmts());
    }

    /** recursively find call/new/reference expressions inside a set of statements. */
    private function walkExprs(string $file, ?string $ns, ?string $classFqn, array $nodes): void
    {
        $visitor = new class ($this, $file, $ns, $classFqn) extends \PhpParser\NodeVisitorAbstract {
            public function __construct(
                private Extractor $ex,
                private string $file,
                private ?string $ns,
                private ?string $classFqn,
            ) {
            }

            public function enterNode(Node $node)
            {
                $this->ex->handleExprNode($this->file, $this->ns, $this->classFqn, $node);
                return null;
            }
        };
        $traverser = new NodeTraverser();
        $traverser->addVisitor($visitor);
        $traverser->traverse($nodes);
    }

    /** dispatched from the body visitor for every node — emits call/reference edges. */
    public function handleExprNode(string $file, ?string $ns, ?string $classFqn, Node $node): void
    {
        $line = $node->getStartLine();
        $from = $this->enclosing($file, $line);

        // Framework-convention dispatch (#43 / ADR-9 Step 0): recorded IN ADDITION
        // to the ordinary call edge below, so the runtime transition lands on the
        // graph as an unresolved `dispatches` edge for `resolve-dispatches`.
        $this->detectDispatch($file, $classFqn, $node, $line, $from);

        if ($node instanceof Node\Expr\FuncCall) {
            if ($node->name instanceof Node\Name) {
                [$id, $name] = $this->resolveFunc($node->name, $ns);
                $this->addEdge($file, $from, $id, $name, 'calls', $line);
            } else {
                $this->addEdge($file, $from, null, '$dynamic()', 'calls', $line); // $fn()
            }
            return;
        }
        if ($node instanceof Node\Expr\StaticCall) {
            [$id, $name] = $this->resolveStaticCall($node, $classFqn);
            $this->addEdge($file, $from, $id, $name, 'calls', $line);
            return;
        }
        if ($node instanceof Node\Expr\New_) {
            [$id, $name] = $this->resolveNew($node, $classFqn);
            $this->addEdge($file, $from, $id, $name, 'calls', $line);
            return;
        }
        if ($node instanceof Node\Expr\MethodCall || $node instanceof Node\Expr\NullsafeMethodCall) {
            [$id, $name] = $this->resolveInstanceCall($node, $classFqn);
            $this->addEdge($file, $from, $id, $name, 'calls', $line);
            return;
        }
        if ($node instanceof Node\Expr\Instanceof_ && $node->class instanceof Node\Name) {
            $this->addTypeEdge($file, $from, $node->class, 'references');
            return;
        }
        if ($node instanceof Node\Expr\ClassConstFetch && $node->class instanceof Node\Name) {
            // Foo::class / Foo::CONST — a static reference to the class symbol
            $this->addTypeEdge($file, $from, $node->class, 'references');
            return;
        }
        if ($node instanceof Node\Stmt\Catch_) {
            foreach ($node->types as $t) {
                $this->addTypeEdge($file, $from, $t, 'references');
            }
            return;
        }
    }

    /**
     * Framework-convention dispatch detection (#43 / ADR-9 Step 0). CakePHP
     * addresses controller actions at runtime through strings the parser treats
     * as opaque data:
     *
     *   $this->redirect(['controller' => 'Foo', 'action' => 'bar'])  → FooController::bar
     *   $this->redirect(['action' => 'bar'])                         → <self>::bar
     *   $this->redirect(['controller' => 'Foo'])                     → FooController::index
     *   $this->setAction('bar')                                      → <self>::bar
     *
     * We emit a `dispatches` edge (`resolved=false`) whose name is the convention
     * key `dispatch <controller>#<action>` — the raw routing values, no class
     * suffix applied. Applying the `<name>Controller` + public-method convention
     * is `librarian resolve-dispatches`'s job (Step 1): the plugin records facts,
     * the post-step resolves them (the ADR-8 shape). Only literal-string routing
     * is emitted; a variable/expression controller or action is genuinely dynamic
     * and out of scope (ADR-9). `<self>` needs the enclosing `*Controller` class —
     * without one, action-only redirects and setAction are skipped.
     */
    private function detectDispatch(string $file, ?string $classFqn, Node $node, int $line, string $from): void
    {
        if (!($node instanceof Node\Expr\MethodCall) && !($node instanceof Node\Expr\NullsafeMethodCall)) {
            return;
        }
        if (!($node->name instanceof Node\Identifier)) {
            return;
        }
        $method = $node->name->toString();
        $self = $this->enclosingControllerConvention($classFqn);

        if ($method === 'redirect') {
            $arg = $node->args[0] ?? null;
            if (!($arg instanceof Node\Arg) || !($arg->value instanceof Node\Expr\Array_)) {
                return; // redirect('/url') or a non-array target: not a routing array
            }
            $route = $this->readRoutingArray($arg->value);
            if ($route['dynamic']) {
                return; // a controller/action key with a variable/expression value — out of scope
            }
            if ($route['controller'] === null && $route['action'] === null) {
                return; // no controller/action key at all — not an action route we can name
            }
            $controller = $route['controller'] ?? $self; // controller omitted → same controller
            if ($controller === null) {
                return; // action-only redirect outside a controller — unknowable
            }
            $action = $route['action'] ?? self::DEFAULT_ACTION;
            $this->addEdge($file, $from, null, 'dispatch ' . $controller . '#' . $action, 'dispatches', $line);
            return;
        }

        if ($method === 'setAction') {
            $arg = $node->args[0] ?? null;
            if (!($arg instanceof Node\Arg) || !($arg->value instanceof Node\Scalar\String_) || $self === null) {
                return;
            }
            $this->addEdge($file, $from, null, 'dispatch ' . $self . '#' . $arg->value->value, 'dispatches', $line);
        }
    }

    /**
     * Read a CakePHP routing array. Distinguishes three states per key so a
     * *present but non-literal* controller/action (`['controller' => $var]`) is
     * treated as dynamic (out of scope) rather than as an omitted key — the
     * latter would emit a false same-controller/default-action transition.
     *
     * @return array{controller:?string,action:?string,dynamic:bool}
     */
    private function readRoutingArray(Node\Expr\Array_ $arr): array
    {
        $controller = null;
        $action = null;
        $dynamic = false;
        foreach ($arr->items as $item) {
            if ($item === null || !($item->key instanceof Node\Scalar\String_)) {
                continue;
            }
            $key = $item->key->value;
            if ($key !== 'controller' && $key !== 'action') {
                continue;
            }
            if (!($item->value instanceof Node\Scalar\String_)) {
                $dynamic = true; // controller/action addressed by a variable/expression
                continue;
            }
            if ($key === 'controller') {
                $controller = $item->value->value;
            } else {
                $action = $item->value->value;
            }
        }
        return ['controller' => $controller, 'action' => $action, 'dynamic' => $dynamic];
    }

    /** routing-convention name of the enclosing controller class (`PostsController` → `Posts`), or null. */
    private function enclosingControllerConvention(?string $classFqn): ?string
    {
        if ($classFqn === null) {
            return null;
        }
        $short = $this->classByFqn[$classFqn]['short'] ?? null;
        if ($short === null || $short === 'Controller' || !str_ends_with($short, 'Controller')) {
            return null;
        }
        return substr($short, 0, -strlen('Controller'));
    }

    /** resolve a function name to a repo symbol, honoring the namespaced→global fallback. */
    private function resolveFunc(Node\Name $name, ?string $ns): array
    {
        $raw = $name->toString();
        if ($name->isFullyQualified()) {
            $fq = fqn($raw);
            if (isset($this->funcByFqn[$fq])) {
                return [$this->funcByFqn[$fq], $raw];
            }
            // external function (#35 §8.1): a `use function Pkg\name` call that
            // NameResolver fully-qualified but this repo does not declare.
            return [null, $this->externalBinding($raw) ?? $raw];
        }
        // unqualified: try current namespace, then global (PHP's runtime rule)
        $candidates = [];
        if ($ns !== null && $ns !== '') {
            $candidates[] = $ns . '\\' . $raw;
        }
        $candidates[] = $raw;
        foreach ($candidates as $c) {
            if (isset($this->funcByFqn[fqn($c)])) {
                return [$this->funcByFqn[fqn($c)], $raw];
            }
        }
        return [null, $raw];
    }

    private function resolveStaticCall(Node\Expr\StaticCall $node, ?string $classFqn): array
    {
        $method = $node->name instanceof Node\Identifier ? $node->name->toString() : null;
        $targetFqn = $this->resolveClassRef($node->class, $classFqn);
        $label = ($node->class instanceof Node\Name ? $node->class->toString() : 'expr') . '::' . ($method ?? '$dynamic');
        if ($targetFqn === null || $method === null) {
            return [null, $label];
        }
        $mid = $this->methodsByClassFqn[$targetFqn][$method] ?? null;
        if ($mid !== null) {
            return [$mid, $label];
        }
        // known class, method not found locally (inherited/trait) → the class symbol
        return [$this->classByFqn[$targetFqn]['id'] ?? null, $label];
    }

    private function resolveNew(Node\Expr\New_ $node, ?string $classFqn): array
    {
        if (!($node->class instanceof Node\Name)) {
            return [null, 'new $dynamic']; // new $var / new class {} / new static via expr
        }
        $targetFqn = $this->resolveClassRef($node->class, $classFqn);
        $label = 'new ' . $node->class->toString();
        if ($targetFqn === null) {
            // external class (#35 §8.1): name the constructor call by origin, so
            // `librarian link` binds it to the class in the declaring repo.
            return [null, $this->externalBinding($node->class->toString()) ?? $label];
        }
        $ctor = $this->methodsByClassFqn[$targetFqn]['__construct'] ?? null;
        return [$ctor ?? ($this->classByFqn[$targetFqn]['id'] ?? null), $label];
    }

    private function resolveInstanceCall(Node\Expr $node, ?string $classFqn): array
    {
        /** @var Node\Expr\MethodCall|Node\Expr\NullsafeMethodCall $node */
        $method = $node->name instanceof Node\Identifier ? $node->name->toString() : null;
        if ($method === null) {
            return [null, '$obj->$dynamic()']; // $obj->$method() — unresolvable
        }
        // $this->method() is the one instance call we can resolve without type inference
        if ($node->var instanceof Node\Expr\Variable && $node->var->name === 'this' && $classFqn !== null) {
            $mid = $this->methodsByClassFqn[$classFqn][$method] ?? null;
            if ($mid !== null) {
                return [$mid, '$this->' . $method];
            }
            // walk up the extends chain within the repo
            $cur = $this->classByFqn[$classFqn]['parent'] ?? null;
            while ($cur !== null) {
                if (isset($this->methodsByClassFqn[$cur][$method])) {
                    return [$this->methodsByClassFqn[$cur][$method], '$this->' . $method];
                }
                $cur = $this->classByFqn[$cur]['parent'] ?? null;
            }
        }
        return [null, '->' . $method]; // general instance dispatch: dynamic, kept raw
    }

    /** resolve a class-position Name (already FQ after NameResolver, or self/static/parent). */
    private function resolveClassRef(Node $class, ?string $classFqn): ?string
    {
        if (!($class instanceof Node\Name)) {
            return null;
        }
        $lower = strtolower($class->toString());
        if ($lower === 'self' || $lower === 'static') {
            return $classFqn;
        }
        if ($lower === 'parent') {
            return $classFqn !== null ? ($this->classByFqn[$classFqn]['parent'] ?? null) : null;
        }
        $fq = fqn($class->toString());
        return isset($this->classByFqn[$fq]) ? $fq : null;
    }

    /** add a resolved-or-raw edge to a class-like Name target. */
    private function addTypeEdge(string $file, string $fromId, Node\Name $name, string $kind): void
    {
        $raw = $name->toString();
        $lower = strtolower($raw);
        if ($lower === 'self' || $lower === 'static' || $lower === 'parent') {
            return;
        }
        $fq = fqn($raw);
        $toId = $this->classByFqn[$fq]['id'] ?? null;
        if ($kind === 'references' && $toId === null) {
            return; // like the TS extractor: only resolved references are stored
        }
        // external extends/implements/trait (#35 §8.1): name by origin package
        $toName = ($toId === null) ? ($this->externalBinding($raw) ?? $raw) : $raw;
        $this->addEdge($file, $fromId, $toId, $toName, $kind, $name->getStartLine());
    }

    /** references for a type hint node, unwrapping nullable/union/intersection. */
    private function addTypeReferences(string $file, string $fromId, ?Node $type): void
    {
        if ($type === null) {
            return;
        }
        if ($type instanceof Node\NullableType) {
            $this->addTypeReferences($file, $fromId, $type->type);
            return;
        }
        if ($type instanceof Node\UnionType || $type instanceof Node\IntersectionType) {
            foreach ($type->types as $t) {
                $this->addTypeReferences($file, $fromId, $t);
            }
            return;
        }
        if ($type instanceof Node\Name) {
            $this->addTypeEdge($file, $fromId, $type, 'references');
        }
    }

    private function funcSignature(Node\FunctionLike $fn): ?string
    {
        $params = [];
        foreach ($fn->getParams() as $p) {
            $t = $p->type ? $this->typeToString($p->type) . ' ' : '';
            $name = $p->var instanceof Node\Expr\Variable && is_string($p->var->name) ? '$' . $p->var->name : '$_';
            $params[] = $t . ($p->variadic ? '...' : '') . $name;
        }
        $ret = $fn->getReturnType() ? ': ' . $this->typeToString($fn->getReturnType()) : '';
        return '(' . implode(', ', $params) . ')' . $ret;
    }

    private function typeToString(Node $type): string
    {
        if ($type instanceof Node\NullableType) {
            return '?' . $this->typeToString($type->type);
        }
        if ($type instanceof Node\UnionType) {
            return implode('|', array_map(fn ($t) => $this->typeToString($t), $type->types));
        }
        if ($type instanceof Node\IntersectionType) {
            return implode('&', array_map(fn ($t) => $this->typeToString($t), $type->types));
        }
        if ($type instanceof Node\Identifier || $type instanceof Node\Name) {
            return $type->toString();
        }
        return 'mixed';
    }

    private function docText(Node $node): ?string
    {
        $doc = $node->getDocComment();
        if ($doc === null) {
            return null;
        }
        $text = trim($doc->getText());
        return $text === '' ? null : $text;
    }

    private function dedupeEdges(array $edges): array
    {
        $seen = [];
        $out = [];
        foreach ($edges as $e) {
            $key = $e['fromId'] . '|' . ($e['toId'] ?? '') . '|' . $e['toName'] . '|' . $e['kind'];
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            $out[] = $e;
        }
        return $out;
    }
}

// ---- entry point: {root, files} on stdin → SCIP+ envelope on stdout ----

// Plugin-protocol handshake (issue #22 / ADR-7): `--capabilities` prints one
// JSON line, reads no stdin, exits 0. The runner queries this to negotiate the
// SCIP+ envelope major version before extracting.
if (in_array('--capabilities', array_slice($argv, 1), true)) {
    echo json_encode([
        'protocol' => 'librarian-scip-plus',
        'protocolVersion' => 1,
        'name' => MONIKER_SCHEME,
        'extensions' => ['.php'],
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit(0);
}

$raw = stream_get_contents(STDIN);
$req = json_decode($raw, true);
if (!is_array($req) || !isset($req['root']) || !isset($req['files'])) {
    fwrite(STDERR, "error: bad request json (want {root, files})\n");
    exit(1);
}

try {
    $extractor = new Extractor((string) $req['root']);
    $out = $extractor->run($req['files']);
    echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
} catch (\Throwable $e) {
    fwrite(STDERR, 'error: ' . $e->getMessage() . "\n");
    exit(1);
}
