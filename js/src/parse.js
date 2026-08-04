// Tokenizer and parser for language v2 (per-bar execution model). Blocks are
// indentation-based: `if`/`for`/multi-line function bodies open
// with a deeper indent and close on dedent. Newlines terminate statements
// except inside unclosed ()/[], which is what permits multi-line calls.
//
// The parser assigns a stable `id` to every call and history node — the
// evaluator keys per-call-site state (indicator windows, draw records,
// history buffers) off those ids, so ids must be deterministic for a given
// source string (they are: sequential in parse order, and the AST is cached
// per source).

// //@version=N pragma (first match anywhere); reserved for future breaking
// changes — currently informative, recorded on the parse result
const PRAGMA_RE = /^\/\/\s*@version\s*=\s*(\d+)\s*$/m;

const RESERVED = new Set(['var', 'if', 'else', 'for', 'while', 'switch', 'break', 'continue']);

// ---------------------------------------------------------------- tokenizer
const tokenize = (src) => {
  const toks = [];
  let i = 0, line = 1, depth = 0;
  const indents = [0];
  // start/end are source character offsets, carried on num/str literals so
  // style edits in the study editor can splice new values into the source
  const push = (type, value, start, end) => toks.push({ type, value, line, start, end });

  // consume a line's leading whitespace and resolve indent/dedent; blank and
  // comment-only lines vanish entirely (no tokens, no indent effect)
  const lineStart = () => {
    for (;;) {
      let col = 0;
      while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r')) {
        col += src[i] === '\t' ? 4 : src[i] === ' ' ? 1 : 0;
        i++;
      }
      if (i >= src.length) return;
      if (src[i] === '\n') { i++; line++; continue; }
      if (src[i] === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      const cur = indents[indents.length - 1];
      if (col > cur) { indents.push(col); push('indent'); }
      else {
        while (col < indents[indents.length - 1]) { indents.pop(); push('dedent'); }
        if (col !== indents[indents.length - 1]) throw new Error(`line ${line}: inconsistent indentation`);
      }
      return;
    }
  };

  lineStart();
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      i++; line++;
      // inside an unclosed ( or [ the newline is plain whitespace — this is
      // what makes multi-line calls work
      if (depth === 0) { push('nl'); lineStart(); }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i, dots = 0;
      while (j < src.length && /[0-9.]/.test(src[j])) {
        if (src[j] === '.') dots++;
        j++;
      }
      if (dots > 1) throw new Error(`line ${line}: malformed number '${src.slice(i, j)}' — only one '.' allowed`);
      push('num', parseFloat(src.slice(i, j)), i, j);
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      // dots allowed inside identifiers so namespaced names (input.int,
      // strategy.buy, barstate.islast) tokenize as one name
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      const w = src.slice(i, j);
      i = j;
      if (w === 'and' || w === 'or' || w === 'not') push('op', w);
      else if (w === 'true') push('num', 1);
      else if (w === 'false') push('num', 0);
      // bare `na` is the NaN literal, but `na(...)` is the is-NaN builtin
      else if (w === 'na') push(src[i] === '(' ? 'id' : 'num', src[i] === '(' ? w : NaN);
      else push('id', w);
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\n') line++;
        j++;
      }
      if (j >= src.length) throw new Error(`line ${line}: unterminated string`);
      push('str', src.slice(i + 1, j), i, j + 1);
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === ':=' || two === '=>') {
      push('op', two);
      i += 2;
      continue;
    }
    if ('+-*/%<>()[],=?:'.includes(c)) {
      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
      push('op', c);
      i++;
      continue;
    }
    throw new Error(`line ${line}: unexpected character '${c}'`);
  }
  push('nl');
  while (indents.length > 1) { indents.pop(); push('dedent'); }
  push('eof');
  return toks;
};

// ------------------------------------------------------------------ parser
export const parse = (src) => {
  const toks = tokenize(src);
  let pos = 0;
  let uid = 0; // node ids for per-call-site evaluator state
  // expression nesting cap: recursive descent means parser (and evaluator)
  // stack depth tracks source nesting — a bound keeps 50k nested parens from
  // overflowing the host stack with an engine-specific error no port could
  // reproduce
  let depth = 0;
  const MAX_DEPTH = 500;
  const fns = {}; // user function definitions, name -> def
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const isOp = (v) => peek().type === 'op' && peek().value === v;
  const isId = (v) => peek().type === 'id' && peek().value === v;
  const expect = (v) => {
    if (!isOp(v)) throw new Error(`line ${peek().line}: expected '${v}'`);
    next();
  };
  const skipNl = () => { while (peek().type === 'nl') next(); };

  const parsePrimary = () => {
    const t = peek();
    if (t.type === 'num' || t.type === 'str') { next(); return { k: 'lit', v: t.value, start: t.start, end: t.end }; }
    if (isOp('(')) {
      next();
      const e = parseExpr();
      expect(')');
      return e;
    }
    if (t.type === 'id') {
      if (RESERVED.has(t.value)) throw new Error(`line ${t.line}: '${t.value}' is a reserved word`);
      next();
      if (isOp('(')) {
        next();
        // null prototype: kwarg names are script-controlled, and a kwarg
        // literally named __proto__ must not rewire the object
        const args = [], kwargs = Object.create(null);
        if (!isOp(')')) {
          for (;;) {
            if (peek().type === 'id' && toks[pos + 1].type === 'op' && toks[pos + 1].value === '=') {
              const key = next().value;
              next();
              if (key in kwargs) throw new Error(`line ${t.line}: duplicate argument '${key}'`);
              kwargs[key] = parseExpr();
            } else {
              args.push(parseExpr());
            }
            if (isOp(',')) { next(); continue; }
            break;
          }
        }
        expect(')');
        return { k: 'call', id: uid++, name: t.value, args, kwargs, kwargKeys: Object.keys(kwargs), line: t.line };
      }
      return { k: 'var', name: t.value, line: t.line };
    }
    if (t.type === 'eof') throw new Error(`line ${t.line}: unexpected end of script`);
    if (t.type === 'nl' || t.type === 'indent' || t.type === 'dedent') throw new Error(`line ${t.line}: unexpected end of line`);
    throw new Error(`line ${t.line}: unexpected '${t.value}'`);
  };

  const parsePostfix = () => {
    let e = parsePrimary();
    while (isOp('[')) {
      const line = peek().line;
      next();
      const idx = parseExpr();
      expect(']');
      e = { k: 'hist', id: uid++, base: e, off: idx, line };
    }
    return e;
  };

  const parseUnary = () => {
    if (++depth > MAX_DEPTH) throw new Error(`line ${peek().line}: expression nesting too deep`);
    try {
      if (isOp('-')) { next(); return { k: 'un', op: '-', a: parseUnary() }; }
      if (isOp('not')) { next(); return { k: 'un', op: 'not', a: parseUnary() }; }
      return parsePostfix();
    } finally {
      depth--;
    }
  };

  const bin = (sub, ops) => () => {
    let e = sub();
    while (peek().type === 'op' && ops.includes(peek().value)) {
      const op = next().value;
      e = { k: 'bin', op, a: e, b: sub() };
    }
    return e;
  };
  const parseMul = bin(parseUnary, ['*', '/', '%']);
  const parseAdd = bin(parseMul, ['+', '-']);
  const parseRel = bin(parseAdd, ['<', '<=', '>', '>=']);
  const parseEq = bin(parseRel, ['==', '!=']);
  const parseAnd = bin(parseEq, ['and']);
  const parseOr = bin(parseAnd, ['or']);

  const parseExpr = () => {
    if (++depth > MAX_DEPTH) throw new Error(`line ${peek().line}: expression nesting too deep`);
    try {
      const c = parseOr();
      if (isOp('?')) {
        next();
        const a = parseExpr();
        expect(':');
        const b = parseExpr();
        return { k: 'cond', c, a, b };
      }
      return c;
    } finally {
      depth--;
    }
  };

  // an indented statement block: NL INDENT stmts DEDENT
  const parseBlock = () => {
    if (peek().type !== 'nl') throw new Error(`line ${peek().line}: expected an indented block`);
    skipNl();
    if (peek().type !== 'indent') throw new Error(`line ${peek().line}: expected an indented block`);
    next();
    const stmts = [];
    skipNl();
    while (peek().type !== 'dedent' && peek().type !== 'eof') {
      const st = parseStatement();
      stmts.push(st);
      const blockEnd = st.k === 'if' || st.k === 'for' || st.k === 'while' || st.k === 'switch' || st.block;
      if (!blockEnd && peek().type !== 'nl' && peek().type !== 'dedent' && peek().type !== 'eof') {
        throw new Error(`line ${peek().line}: unexpected '${peek().value}' after statement`);
      }
      skipNl();
    }
    if (peek().type === 'dedent') next();
    return stmts;
  };

  const parseIf = (line) => {
    const cond = parseExpr();
    const then = parseBlock();
    let els = null;
    skipNl();
    if (isId('else')) {
      next();
      if (isId('if')) {
        const t = next();
        els = [parseIf(t.line)];
      } else {
        els = parseBlock();
      }
    }
    return { k: 'if', cond, then, els, line };
  };

  // lookahead for `name(params) =>` — distinguishes a function definition
  // from a call-expression statement
  const isFuncDef = () => {
    if (peek().type !== 'id' || toks[pos + 1]?.type !== 'op' || toks[pos + 1].value !== '(') return false;
    let j = pos + 2;
    while (toks[j] && (toks[j].type === 'id' || (toks[j].type === 'op' && toks[j].value === ','))) j++;
    return toks[j]?.type === 'op' && toks[j].value === ')'
      && toks[j + 1]?.type === 'op' && toks[j + 1].value === '=>';
  };

  const parseStatement = (topLevel = false) => {
    const t = peek();
    if (t.type === 'id' && t.value === 'var') {
      next();
      if (peek().type !== 'id') throw new Error(`line ${t.line}: expected a variable name after 'var'`);
      const name = next().value;
      expect('=');
      return { k: 'vardecl', id: uid++, name, expr: parseExpr(), line: t.line };
    }
    if (t.type === 'id' && t.value === 'if') {
      next();
      return parseIf(t.line);
    }
    if (t.type === 'id' && t.value === 'else') throw new Error(`line ${t.line}: 'else' without a matching 'if'`);
    if (t.type === 'id' && t.value === 'for') {
      next();
      if (peek().type !== 'id') throw new Error(`line ${t.line}: expected a loop variable after 'for'`);
      const name = next().value;
      expect('=');
      const from = parseExpr();
      if (!isId('to')) throw new Error(`line ${t.line}: expected 'to' in for loop`);
      next();
      const to = parseExpr();
      let by = null;
      if (isId('by')) { next(); by = parseExpr(); }
      const body = parseBlock();
      return { k: 'for', name, from, to, by, body, line: t.line };
    }
    if (t.type === 'id' && t.value === 'while') {
      next();
      const cond = parseExpr();
      const body = parseBlock();
      return { k: 'while', cond, body, line: t.line };
    }
    if (t.type === 'id' && (t.value === 'break' || t.value === 'continue')) {
      next();
      return { k: t.value, line: t.line };
    }
    if (t.type === 'id' && t.value === 'switch') {
      next();
      const subject = parseExpr();
      // arm block: `test => statement` lines; a bare `=>` is the default arm
      if (peek().type !== 'nl') throw new Error(`line ${t.line}: expected an indented block`);
      skipNl();
      if (peek().type !== 'indent') throw new Error(`line ${t.line}: expected an indented block`);
      next();
      const arms = [];
      skipNl();
      while (peek().type !== 'dedent' && peek().type !== 'eof') {
        const armLine = peek().line;
        let test = null;
        if (!isOp('=>')) test = parseExpr();
        if (!isOp('=>')) throw new Error(`line ${armLine}: expected '=>' in switch arm`);
        next();
        const stmt = parseStatement(false);
        if (!['expr', 'assign', 'reassign', 'break', 'continue'].includes(stmt.k)) {
          throw new Error(`line ${armLine}: switch arms must be single-line statements`);
        }
        arms.push({ test, stmt });
        skipNl();
      }
      if (peek().type === 'dedent') next();
      return { k: 'switch', subject, arms, line: t.line };
    }
    if (isFuncDef()) {
      if (!topLevel) throw new Error(`line ${t.line}: functions may only be defined at the top level`);
      const name = next().value;
      if (fns[name]) throw new Error(`line ${t.line}: function '${name}' is already defined`);
      next(); // (
      // grammar: comma-separated, no trailing comma, unique names
      const params = [];
      if (peek().type === 'id') {
        params.push(next().value);
        while (isOp(',')) {
          next();
          if (peek().type !== 'id') throw new Error(`line ${t.line}: expected a parameter name after ','`);
          const p = next().value;
          if (params.includes(p)) throw new Error(`line ${t.line}: duplicate parameter '${p}'`);
          params.push(p);
        }
      }
      expect(')');
      next(); // =>
      if (peek().type === 'nl') {
        const body = parseBlock();
        if (!body.length) throw new Error(`line ${t.line}: empty function body`);
        // the last statement must be an expression — its value is returned
        if (body[body.length - 1].k !== 'expr') throw new Error(`line ${t.line}: a function body must end with an expression (the return value)`);
        fns[name] = { name, params, body: body.slice(0, -1), ret: body[body.length - 1].expr, line: t.line };
        return { k: 'fndef', name, block: true, line: t.line };
      }
      fns[name] = { name, params, body: [], ret: parseExpr(), line: t.line };
      return { k: 'fndef', name, line: t.line };
    }
    if (t.type === 'id' && toks[pos + 1].type === 'op' && toks[pos + 1].value === '=') {
      next();
      next();
      return { k: 'assign', name: t.value, expr: parseExpr(), line: t.line };
    }
    if (t.type === 'id' && toks[pos + 1].type === 'op' && toks[pos + 1].value === ':=') {
      next();
      next();
      return { k: 'reassign', name: t.value, expr: parseExpr(), line: t.line };
    }
    const st = { k: 'expr', expr: parseExpr(), line: t.line };
    return st;
  };

  const stmts = [];
  skipNl();
  while (peek().type !== 'eof') {
    if (peek().type === 'indent') throw new Error(`line ${peek().line}: unexpected indentation`);
    if (peek().type === 'dedent') { next(); continue; }
    const st = parseStatement(true);
    stmts.push(st);
    // a statement ending in an indented block consumed its terminator (the
    // newline sits before the dedent), so only line statements need one
    const blockEnd = st.k === 'if' || st.k === 'for' || st.k === 'while' || st.k === 'switch' || st.block;
    if (!blockEnd && peek().type !== 'eof' && peek().type !== 'nl') {
      throw new Error(`line ${peek().line}: unexpected '${peek().value}' after statement`);
    }
    skipNl();
  }

  const m = PRAGMA_RE.exec(src);
  return { stmts, fns, pragma: m ? +m[1] : null };
};

// declaration calls that must sit in top-level statements: their records are
// created once and collected per bar, which conditional or repeated execution
// would break
export const TOP_LEVEL_ONLY = new Set([
  'study', 'plot', 'hline', 'fill', 'plotshape', 'plotbuy', 'plotsell',
  'infopanel', 'barcolor', 'bgcolor', 'alertcondition',
  'strategy.buy', 'strategy.sell', 'strategy.config',
  'input', 'input.int', 'input.float', 'input.time', 'input.bool', 'input.string',
  'line.new', 'label.new', 'box.new',
  'security',
]);

const walkExpr = (node, cb) => {
  if (!node || typeof node !== 'object') return;
  if (node.k === 'call') {
    cb(node);
    node.args.forEach(a => walkExpr(a, cb));
    Object.keys(node.kwargs).forEach(key => walkExpr(node.kwargs[key], cb));
    return;
  }
  if (node.k === 'un') walkExpr(node.a, cb);
  else if (node.k === 'bin') { walkExpr(node.a, cb); walkExpr(node.b, cb); }
  else if (node.k === 'cond') { walkExpr(node.c, cb); walkExpr(node.a, cb); walkExpr(node.b, cb); }
  else if (node.k === 'hist') { walkExpr(node.base, cb); walkExpr(node.off, cb); }
};

// expressions that evaluate exactly once per bar when the statement runs
const exprsOf = (st) => {
  switch (st.k) {
    case 'assign': case 'reassign': case 'vardecl': case 'expr': return [st.expr];
    case 'if': return [st.cond];
    case 'for': return st.by ? [st.from, st.to, st.by] : [st.from, st.to];
    case 'switch': return [st.subject];
    default: return [];
  }
};
// expressions that evaluate repeatedly (while conds, once per iteration) or
// conditionally (switch arm tests) — declaration calls in them would break
// every once-per-bar draw/input/order invariant, so validation treats them
// like block bodies
const condExprsOf = (st) => {
  switch (st.k) {
    case 'while': return [st.cond];
    case 'switch': return st.arms.map(a => a.test).filter(Boolean);
    default: return [];
  }
};
const childrenOf = (st) => (
  st.k === 'if' ? [...st.then, ...(st.els || [])]
    : st.k === 'for' || st.k === 'while' ? st.body
      : st.k === 'switch' ? st.arms.map(a => a.stmt)
        : []);
// visit every statement in the tree; inBlock is true inside if/for bodies
const eachStmt = (list, cb, inBlock = false) => list.forEach(st => {
  cb(st, inBlock);
  eachStmt(childrenOf(st), cb, true);
});
// every call node anywhere under a statement list
const eachCall = (list, cb) => eachStmt(list, (st, inBlock) => {
  exprsOf(st).forEach(e => walkExpr(e, call => cb(call, inBlock)));
  condExprsOf(st).forEach(e => walkExpr(e, call => cb(call, true)));
});

// post-parse validation: draw/declare calls only at top level, user function
// call graph is acyclic and never contains declaration calls
// break/continue are only meaningful inside for/while bodies
const checkLoopFlow = (list, inLoop) => {
  list.forEach(st => {
    if ((st.k === 'break' || st.k === 'continue') && !inLoop) {
      throw new Error(`line ${st.line}: '${st.k}' outside of a loop`);
    }
    const loops = st.k === 'for' || st.k === 'while';
    childrenOf(st).forEach(child => checkLoopFlow([child], loops || inLoop));
  });
};

export const validate = ({ stmts, fns }) => {
  checkLoopFlow(stmts, false);
  Object.keys(fns).forEach(name => checkLoopFlow(fns[name].body, false));
  // security(tf, expr) evaluates its expression in another bar context —
  // declarations and nested security calls make no sense there
  const checkSecurityArgs = (call) => {
    if (call.name !== 'security') return;
    call.args.forEach(a => walkExpr(a, inner => {
      if (TOP_LEVEL_ONLY.has(inner.name)) {
        throw new Error(`line ${inner.line}: ${inner.name}() is not allowed inside security()`);
      }
    }));
    Object.keys(call.kwargs || {}).forEach(k => walkExpr(call.kwargs[k], inner => {
      if (TOP_LEVEL_ONLY.has(inner.name)) {
        throw new Error(`line ${inner.line}: ${inner.name}() is not allowed inside security()`);
      }
    }));
  };
  eachCall(stmts, (call) => checkSecurityArgs(call));
  eachCall(stmts, (call, inBlock) => {
    if (inBlock && TOP_LEVEL_ONLY.has(call.name)) {
      throw new Error(`line ${call.line}: ${call.name}() must be at the top level of the script, not inside a block, while condition or switch arm`);
    }
  });
  const fnStmts = (fn) => [...fn.body, { k: 'expr', expr: fn.ret }];
  Object.keys(fns).forEach(name => {
    eachCall(fnStmts(fns[name]), (call) => {
      if (TOP_LEVEL_ONLY.has(call.name)) {
        throw new Error(`line ${call.line}: ${call.name}() is not allowed inside function '${name}'`);
      }
    });
  });
  // reject recursion: depth-first over the user-function call graph
  const visiting = new Set(), done = new Set();
  const visit = (name, fromLine) => {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`line ${fromLine}: recursive function '${name}' is not allowed`);
    visiting.add(name);
    eachCall(fnStmts(fns[name]), (call) => { if (fns[call.name]) visit(call.name, call.line); });
    visiting.delete(name);
    done.add(name);
  };
  Object.keys(fns).forEach(n => visit(n, fns[n].line));
};
