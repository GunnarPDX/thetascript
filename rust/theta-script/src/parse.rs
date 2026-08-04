//! Tokenizer and parser for language v2 — a direct port of js/src/parse.js.
//! Literal spans are recorded in UTF-16 code units (JavaScript string
//! indices), so colorSpan/widthSpan in the output match the reference
//! implementation byte-for-byte even around non-ASCII source characters.

use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
pub enum Tok {
    Nl,
    Indent,
    Dedent,
    Num(f64),
    Str(String),
    Id(String),
    Op(&'static str),
    Eof,
}

#[derive(Clone, Debug)]
pub struct Token {
    pub tok: Tok,
    pub line: usize,
    pub start: usize, // UTF-16 offset, literals only
    pub end: usize,
}

#[derive(Clone, Debug)]
pub enum Expr {
    NumLit {
        v: f64,
        span: Option<(usize, usize)>,
    },
    StrLit {
        v: String,
        span: Option<(usize, usize)>,
    },
    Var {
        name: String,
        line: usize,
    },
    Un {
        op: &'static str,
        a: Box<Expr>,
    },
    Bin {
        op: &'static str,
        a: Box<Expr>,
        b: Box<Expr>,
    },
    Cond {
        c: Box<Expr>,
        a: Box<Expr>,
        b: Box<Expr>,
    },
    Hist {
        id: usize,
        base: Box<Expr>,
        off: Box<Expr>,
        line: usize,
    },
    Call {
        id: usize,
        name: String,
        args: Vec<Expr>,
        kwargs: Vec<(String, Expr)>,
        line: usize,
    },
}

#[derive(Clone, Debug)]
pub enum Stmt {
    Expr {
        expr: Expr,
    },
    Assign {
        name: String,
        expr: Expr,
        line: usize,
    },
    Reassign {
        name: String,
        expr: Expr,
        line: usize,
    },
    VarDecl {
        id: usize,
        name: String,
        expr: Expr,
        line: usize,
    },
    If {
        cond: Expr,
        then: Vec<Stmt>,
        els: Option<Vec<Stmt>>,
    },
    For {
        name: String,
        from: Expr,
        to: Expr,
        by: Option<Expr>,
        body: Vec<Stmt>,
        line: usize,
    },
    While {
        cond: Expr,
        body: Vec<Stmt>,
        line: usize,
    },
    Break {
        line: usize,
    },
    Continue {
        line: usize,
    },
    Switch {
        subject: Expr,
        arms: Vec<(Option<Expr>, Box<Stmt>)>,
        line: usize,
    },
    FnDef {
        name: String,
        block: bool,
    },
}

#[derive(Clone, Debug)]
pub struct FnDef {
    pub params: Vec<String>,
    pub body: Vec<Stmt>,
    pub ret: Expr,
    pub line: usize,
}

pub struct Ast {
    pub stmts: Vec<Stmt>,
    pub fns: HashMap<String, FnDef>,
}

const RESERVED: [&str; 8] = [
    "var", "if", "else", "for", "while", "switch", "break", "continue",
];

fn is_reserved(w: &str) -> bool {
    RESERVED.contains(&w)
}

// ---------------------------------------------------------------- tokenizer

struct Lexer {
    chars: Vec<char>,
    u16pos: Vec<usize>, // UTF-16 offset of chars[i]; last entry = total length
    i: usize,
    line: usize,
    depth: usize,
    indents: Vec<usize>,
    toks: Vec<Token>,
}

impl Lexer {
    fn new(src: &str) -> Self {
        let chars: Vec<char> = src.chars().collect();
        let mut u16pos = Vec::with_capacity(chars.len() + 1);
        let mut p = 0usize;
        for c in &chars {
            u16pos.push(p);
            p += c.len_utf16();
        }
        u16pos.push(p);
        Lexer {
            chars,
            u16pos,
            i: 0,
            line: 1,
            depth: 0,
            indents: vec![0],
            toks: Vec::new(),
        }
    }

    fn at(&self, k: usize) -> Option<char> {
        self.chars.get(k).copied()
    }

    fn push(&mut self, tok: Tok) {
        self.toks.push(Token {
            tok,
            line: self.line,
            start: 0,
            end: 0,
        });
    }

    fn push_span(&mut self, tok: Tok, start: usize, end: usize) {
        self.toks.push(Token {
            tok,
            line: self.line,
            start: self.u16pos[start],
            end: self.u16pos[end],
        });
    }

    // consume a line's leading whitespace and resolve indent/dedent; blank
    // and comment-only lines vanish entirely
    fn line_start(&mut self) -> Result<(), String> {
        loop {
            let mut col = 0usize;
            while let Some(c) = self.at(self.i) {
                match c {
                    '\t' => col += 4,
                    ' ' => col += 1,
                    '\r' => {}
                    _ => break,
                }
                self.i += 1;
            }
            match self.at(self.i) {
                None => return Ok(()),
                Some('\n') => {
                    self.i += 1;
                    self.line += 1;
                    continue;
                }
                Some('/') if self.at(self.i + 1) == Some('/') => {
                    while self.at(self.i).is_some_and(|c| c != '\n') {
                        self.i += 1;
                    }
                    continue;
                }
                Some(_) => {
                    let cur = *self.indents.last().unwrap();
                    if col > cur {
                        self.indents.push(col);
                        self.push(Tok::Indent);
                    } else {
                        while col < *self.indents.last().unwrap() {
                            self.indents.pop();
                            self.push(Tok::Dedent);
                        }
                        if col != *self.indents.last().unwrap() {
                            return Err(format!("line {}: inconsistent indentation", self.line));
                        }
                    }
                    return Ok(());
                }
            }
        }
    }

    fn run(mut self) -> Result<Vec<Token>, String> {
        self.line_start()?;
        while let Some(c) = self.at(self.i) {
            if c == '/' && self.at(self.i + 1) == Some('/') {
                while self.at(self.i).is_some_and(|c| c != '\n') {
                    self.i += 1;
                }
                continue;
            }
            if c == '\n' {
                self.i += 1;
                self.line += 1;
                // inside an unclosed ( or [ the newline is plain whitespace
                if self.depth == 0 {
                    self.push(Tok::Nl);
                    self.line_start()?;
                }
                continue;
            }
            if c == ' ' || c == '\t' || c == '\r' {
                self.i += 1;
                continue;
            }
            if c.is_ascii_digit()
                || (c == '.' && self.at(self.i + 1).is_some_and(|d| d.is_ascii_digit()))
            {
                let start = self.i;
                let mut dots = 0;
                while let Some(d) = self.at(self.i) {
                    if d == '.' {
                        dots += 1;
                    } else if !d.is_ascii_digit() {
                        break;
                    }
                    self.i += 1;
                }
                let text: String = self.chars[start..self.i].iter().collect();
                if dots > 1 {
                    return Err(format!(
                        "line {}: malformed number '{}' — only one '.' allowed",
                        self.line, text
                    ));
                }
                let v: f64 = text.parse().unwrap_or(f64::NAN);
                self.push_span(Tok::Num(v), start, self.i);
                continue;
            }
            if c.is_ascii_alphabetic() || c == '_' {
                let start = self.i;
                while self
                    .at(self.i)
                    .is_some_and(|d| d.is_ascii_alphanumeric() || d == '_' || d == '.')
                {
                    self.i += 1;
                }
                let w: String = self.chars[start..self.i].iter().collect();
                match w.as_str() {
                    "and" => self.push(Tok::Op("and")),
                    "or" => self.push(Tok::Op("or")),
                    "not" => self.push(Tok::Op("not")),
                    "true" => self.push(Tok::Num(1.0)),
                    "false" => self.push(Tok::Num(0.0)),
                    // bare `na` is the NaN literal, but `na(...)` is the builtin
                    "na" => {
                        if self.at(self.i) == Some('(') {
                            self.push(Tok::Id(w));
                        } else {
                            self.push(Tok::Num(f64::NAN));
                        }
                    }
                    _ => self.push(Tok::Id(w)),
                }
                continue;
            }
            if c == '"' || c == '\'' {
                let start = self.i;
                let mut j = self.i + 1;
                while let Some(d) = self.at(j) {
                    if d == c {
                        break;
                    }
                    if d == '\n' {
                        self.line += 1;
                    }
                    j += 1;
                }
                if self.at(j).is_none() {
                    return Err(format!("line {}: unterminated string", self.line));
                }
                let s: String = self.chars[start + 1..j].iter().collect();
                self.push_span(Tok::Str(s), start, j + 1);
                self.i = j + 1;
                continue;
            }
            let two: String = self.chars[self.i..(self.i + 2).min(self.chars.len())]
                .iter()
                .collect();
            const TWOS: [&str; 6] = ["==", "!=", "<=", ">=", ":=", "=>"];
            if let Some(op) = TWOS.iter().find(|t| **t == two) {
                self.push(Tok::Op(op));
                self.i += 2;
                continue;
            }
            const ONES: &str = "+-*/%<>()[],=?:";
            if ONES.contains(c) {
                if c == '(' || c == '[' {
                    self.depth += 1;
                }
                if c == ')' || c == ']' {
                    self.depth = self.depth.saturating_sub(1);
                }
                let op: &'static str = match c {
                    '+' => "+",
                    '-' => "-",
                    '*' => "*",
                    '/' => "/",
                    '%' => "%",
                    '<' => "<",
                    '>' => ">",
                    '(' => "(",
                    ')' => ")",
                    '[' => "[",
                    ']' => "]",
                    ',' => ",",
                    '=' => "=",
                    '?' => "?",
                    ':' => ":",
                    _ => unreachable!(),
                };
                self.push(Tok::Op(op));
                self.i += 1;
                continue;
            }
            return Err(format!("line {}: unexpected character '{}'", self.line, c));
        }
        self.push(Tok::Nl);
        while self.indents.len() > 1 {
            self.indents.pop();
            self.push(Tok::Dedent);
        }
        self.push(Tok::Eof);
        Ok(self.toks)
    }
}

// ------------------------------------------------------------------ parser

struct Parser {
    toks: Vec<Token>,
    pos: usize,
    uid: usize,
    // expression nesting cap: recursive descent means parser stack depth
    // tracks source nesting — a bound keeps deeply nested parens from
    // overflowing the host stack with an engine-specific error
    depth: usize,
    fns: HashMap<String, FnDef>,
}

const MAX_DEPTH: usize = 500;

impl Parser {
    fn peek(&self) -> &Token {
        &self.toks[self.pos]
    }

    fn next(&mut self) -> Token {
        let t = self.toks[self.pos].clone();
        self.pos += 1;
        t
    }

    fn is_op(&self, v: &str) -> bool {
        matches!(&self.peek().tok, Tok::Op(o) if *o == v)
    }

    fn is_id(&self, v: &str) -> bool {
        matches!(&self.peek().tok, Tok::Id(w) if w == v)
    }

    fn expect(&mut self, v: &str) -> Result<(), String> {
        if !self.is_op(v) {
            return Err(format!("line {}: expected '{}'", self.peek().line, v));
        }
        self.pos += 1;
        Ok(())
    }

    fn skip_nl(&mut self) {
        while matches!(self.peek().tok, Tok::Nl) {
            self.pos += 1;
        }
    }

    fn tok_desc(t: &Tok) -> String {
        match t {
            Tok::Num(v) => format!("{}", v),
            Tok::Str(s) => s.clone(),
            Tok::Id(w) => w.clone(),
            Tok::Op(o) => o.to_string(),
            _ => "?".into(),
        }
    }

    fn parse_primary(&mut self) -> Result<Expr, String> {
        let t = self.peek().clone();
        match &t.tok {
            Tok::Num(v) => {
                self.pos += 1;
                let span = if t.end > 0 || t.start > 0 {
                    Some((t.start, t.end))
                } else {
                    None
                };
                Ok(Expr::NumLit { v: *v, span })
            }
            Tok::Str(s) => {
                self.pos += 1;
                Ok(Expr::StrLit {
                    v: s.clone(),
                    span: Some((t.start, t.end)),
                })
            }
            Tok::Op("(") => {
                self.pos += 1;
                let e = self.parse_expr()?;
                self.expect(")")?;
                Ok(e)
            }
            Tok::Id(name) => {
                if is_reserved(name) {
                    return Err(format!("line {}: '{}' is a reserved word", t.line, name));
                }
                let name = name.clone();
                self.pos += 1;
                if self.is_op("(") {
                    self.pos += 1;
                    let mut args = Vec::new();
                    let mut kwargs = Vec::new();
                    if !self.is_op(")") {
                        loop {
                            let is_kw = matches!(&self.peek().tok, Tok::Id(_))
                                && matches!(&self.toks[self.pos + 1].tok, Tok::Op("="));
                            if is_kw {
                                let key = match self.next().tok {
                                    Tok::Id(k) => k,
                                    _ => unreachable!(),
                                };
                                self.pos += 1; // =
                                if kwargs.iter().any(|(k, _)| *k == key) {
                                    return Err(format!(
                                        "line {}: duplicate argument '{}'",
                                        t.line, key
                                    ));
                                }
                                kwargs.push((key, self.parse_expr()?));
                            } else {
                                args.push(self.parse_expr()?);
                            }
                            if self.is_op(",") {
                                self.pos += 1;
                                continue;
                            }
                            break;
                        }
                    }
                    self.expect(")")?;
                    let id = self.uid;
                    self.uid += 1;
                    return Ok(Expr::Call {
                        id,
                        name,
                        args,
                        kwargs,
                        line: t.line,
                    });
                }
                Ok(Expr::Var { name, line: t.line })
            }
            Tok::Eof => Err(format!("line {}: unexpected end of script", t.line)),
            Tok::Nl | Tok::Indent | Tok::Dedent => {
                Err(format!("line {}: unexpected end of line", t.line))
            }
            _ => Err(format!(
                "line {}: unexpected '{}'",
                t.line,
                Self::tok_desc(&t.tok)
            )),
        }
    }

    fn parse_postfix(&mut self) -> Result<Expr, String> {
        let mut e = self.parse_primary()?;
        while self.is_op("[") {
            let line = self.peek().line;
            self.pos += 1;
            let idx = self.parse_expr()?;
            self.expect("]")?;
            let id = self.uid;
            self.uid += 1;
            e = Expr::Hist {
                id,
                base: Box::new(e),
                off: Box::new(idx),
                line,
            };
        }
        Ok(e)
    }

    fn parse_unary(&mut self) -> Result<Expr, String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            self.depth -= 1;
            return Err(format!(
                "line {}: expression nesting too deep",
                self.peek().line
            ));
        }
        let r = self.parse_unary_inner();
        self.depth -= 1;
        r
    }

    fn parse_unary_inner(&mut self) -> Result<Expr, String> {
        if self.is_op("-") {
            self.pos += 1;
            return Ok(Expr::Un {
                op: "-",
                a: Box::new(self.parse_unary()?),
            });
        }
        if self.is_op("not") {
            self.pos += 1;
            return Ok(Expr::Un {
                op: "not",
                a: Box::new(self.parse_unary()?),
            });
        }
        self.parse_postfix()
    }

    fn parse_bin(&mut self, level: usize) -> Result<Expr, String> {
        const LEVELS: [&[&str]; 6] = [
            &["or"],
            &["and"],
            &["==", "!="],
            &["<", "<=", ">", ">="],
            &["+", "-"],
            &["*", "/", "%"],
        ];
        if level >= LEVELS.len() {
            return self.parse_unary();
        }
        let mut e = self.parse_bin(level + 1)?;
        loop {
            let op = match &self.peek().tok {
                Tok::Op(o) if LEVELS[level].contains(o) => *o,
                _ => break,
            };
            self.pos += 1;
            let b = self.parse_bin(level + 1)?;
            e = Expr::Bin {
                op,
                a: Box::new(e),
                b: Box::new(b),
            };
        }
        Ok(e)
    }

    fn parse_expr(&mut self) -> Result<Expr, String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            self.depth -= 1;
            return Err(format!(
                "line {}: expression nesting too deep",
                self.peek().line
            ));
        }
        let r = self.parse_expr_inner();
        self.depth -= 1;
        r
    }

    fn parse_expr_inner(&mut self) -> Result<Expr, String> {
        let c = self.parse_bin(0)?;
        if self.is_op("?") {
            self.pos += 1;
            let a = self.parse_expr()?;
            self.expect(":")?;
            let b = self.parse_expr()?;
            return Ok(Expr::Cond {
                c: Box::new(c),
                a: Box::new(a),
                b: Box::new(b),
            });
        }
        Ok(c)
    }

    fn parse_block(&mut self) -> Result<Vec<Stmt>, String> {
        if !matches!(self.peek().tok, Tok::Nl) {
            return Err(format!(
                "line {}: expected an indented block",
                self.peek().line
            ));
        }
        self.skip_nl();
        if !matches!(self.peek().tok, Tok::Indent) {
            return Err(format!(
                "line {}: expected an indented block",
                self.peek().line
            ));
        }
        self.pos += 1;
        let mut stmts = Vec::new();
        self.skip_nl();
        while !matches!(self.peek().tok, Tok::Dedent | Tok::Eof) {
            let st = self.parse_statement(false)?;
            let block_end = matches!(
                st,
                Stmt::If { .. }
                    | Stmt::For { .. }
                    | Stmt::While { .. }
                    | Stmt::Switch { .. }
                    | Stmt::FnDef { block: true, .. }
            );
            stmts.push(st);
            if !block_end && !matches!(self.peek().tok, Tok::Nl | Tok::Dedent | Tok::Eof) {
                return Err(format!(
                    "line {}: unexpected '{}' after statement",
                    self.peek().line,
                    Self::tok_desc(&self.peek().tok)
                ));
            }
            self.skip_nl();
        }
        if matches!(self.peek().tok, Tok::Dedent) {
            self.pos += 1;
        }
        Ok(stmts)
    }

    fn parse_if(&mut self) -> Result<Stmt, String> {
        let cond = self.parse_expr()?;
        let then = self.parse_block()?;
        let mut els = None;
        self.skip_nl();
        if self.is_id("else") {
            self.pos += 1;
            if self.is_id("if") {
                self.pos += 1;
                els = Some(vec![self.parse_if()?]);
            } else {
                els = Some(self.parse_block()?);
            }
        }
        Ok(Stmt::If { cond, then, els })
    }

    // lookahead for `name(params) =>`
    fn is_func_def(&self) -> bool {
        if !matches!(self.peek().tok, Tok::Id(_))
            || !matches!(self.toks[self.pos + 1].tok, Tok::Op("("))
        {
            return false;
        }
        let mut j = self.pos + 2;
        while matches!(self.toks[j].tok, Tok::Id(_) | Tok::Op(",")) {
            j += 1;
        }
        matches!(self.toks[j].tok, Tok::Op(")")) && matches!(self.toks[j + 1].tok, Tok::Op("=>"))
    }

    fn parse_statement(&mut self, top_level: bool) -> Result<Stmt, String> {
        let t = self.peek().clone();
        if let Tok::Id(word) = &t.tok {
            if word == "var" {
                self.pos += 1;
                let name = match &self.peek().tok {
                    Tok::Id(n) => n.clone(),
                    _ => {
                        return Err(format!(
                            "line {}: expected a variable name after 'var'",
                            t.line
                        ))
                    }
                };
                self.pos += 1;
                self.expect("=")?;
                let id = self.uid;
                self.uid += 1;
                return Ok(Stmt::VarDecl {
                    id,
                    name,
                    expr: self.parse_expr()?,
                    line: t.line,
                });
            }
            if word == "if" {
                self.pos += 1;
                return self.parse_if();
            }
            if word == "else" {
                return Err(format!("line {}: 'else' without a matching 'if'", t.line));
            }
            if word == "while" {
                self.pos += 1;
                let cond = self.parse_expr()?;
                let body = self.parse_block()?;
                return Ok(Stmt::While {
                    cond,
                    body,
                    line: t.line,
                });
            }
            if word == "break" {
                self.pos += 1;
                return Ok(Stmt::Break { line: t.line });
            }
            if word == "continue" {
                self.pos += 1;
                return Ok(Stmt::Continue { line: t.line });
            }
            if word == "switch" {
                self.pos += 1;
                let subject = self.parse_expr()?;
                if !matches!(self.peek().tok, Tok::Nl) {
                    return Err(format!("line {}: expected an indented block", t.line));
                }
                self.skip_nl();
                if !matches!(self.peek().tok, Tok::Indent) {
                    return Err(format!("line {}: expected an indented block", t.line));
                }
                self.pos += 1;
                let mut arms = Vec::new();
                self.skip_nl();
                while !matches!(self.peek().tok, Tok::Dedent | Tok::Eof) {
                    let arm_line = self.peek().line;
                    let test = if self.is_op("=>") {
                        None
                    } else {
                        Some(self.parse_expr()?)
                    };
                    if !self.is_op("=>") {
                        return Err(format!("line {}: expected '=>' in switch arm", arm_line));
                    }
                    self.pos += 1;
                    let stmt = self.parse_statement(false)?;
                    if !matches!(
                        stmt,
                        Stmt::Expr { .. }
                            | Stmt::Assign { .. }
                            | Stmt::Reassign { .. }
                            | Stmt::Break { .. }
                            | Stmt::Continue { .. }
                    ) {
                        return Err(format!(
                            "line {}: switch arms must be single-line statements",
                            arm_line
                        ));
                    }
                    arms.push((test, Box::new(stmt)));
                    self.skip_nl();
                }
                if matches!(self.peek().tok, Tok::Dedent) {
                    self.pos += 1;
                }
                return Ok(Stmt::Switch {
                    subject,
                    arms,
                    line: t.line,
                });
            }
            if word == "for" {
                self.pos += 1;
                let name = match &self.peek().tok {
                    Tok::Id(n) => n.clone(),
                    _ => {
                        return Err(format!(
                            "line {}: expected a loop variable after 'for'",
                            t.line
                        ))
                    }
                };
                self.pos += 1;
                self.expect("=")?;
                let from = self.parse_expr()?;
                if !self.is_id("to") {
                    return Err(format!("line {}: expected 'to' in for loop", t.line));
                }
                self.pos += 1;
                let to = self.parse_expr()?;
                let by = if self.is_id("by") {
                    self.pos += 1;
                    Some(self.parse_expr()?)
                } else {
                    None
                };
                let body = self.parse_block()?;
                return Ok(Stmt::For {
                    name,
                    from,
                    to,
                    by,
                    body,
                    line: t.line,
                });
            }
            if self.is_func_def() {
                if !top_level {
                    return Err(format!(
                        "line {}: functions may only be defined at the top level",
                        t.line
                    ));
                }
                let name = word.clone();
                if self.fns.contains_key(&name) {
                    return Err(format!(
                        "line {}: function '{}' is already defined",
                        t.line, name
                    ));
                }
                self.pos += 2; // name (
                               // grammar: comma-separated, no trailing comma, unique names
                let mut params = Vec::new();
                if let Tok::Id(p) = &self.peek().tok {
                    params.push(p.clone());
                    self.pos += 1;
                    while self.is_op(",") {
                        self.pos += 1;
                        let p = match &self.peek().tok {
                            Tok::Id(p) => p.clone(),
                            _ => {
                                return Err(format!(
                                    "line {}: expected a parameter name after ','",
                                    t.line
                                ))
                            }
                        };
                        self.pos += 1;
                        if params.contains(&p) {
                            return Err(format!("line {}: duplicate parameter '{}'", t.line, p));
                        }
                        params.push(p);
                    }
                }
                self.expect(")")?;
                self.pos += 1; // =>
                if matches!(self.peek().tok, Tok::Nl) {
                    let mut body = self.parse_block()?;
                    if body.is_empty() {
                        return Err(format!("line {}: empty function body", t.line));
                    }
                    match body.pop().unwrap() {
                        Stmt::Expr { expr } => {
                            self.fns.insert(name.clone(), FnDef { params, body, ret: expr, line: t.line });
                        }
                        _ => {
                            return Err(format!(
                                "line {}: a function body must end with an expression (the return value)",
                                t.line
                            ))
                        }
                    }
                    return Ok(Stmt::FnDef { name, block: true });
                }
                let ret = self.parse_expr()?;
                self.fns.insert(
                    name.clone(),
                    FnDef {
                        params,
                        body: Vec::new(),
                        ret,
                        line: t.line,
                    },
                );
                return Ok(Stmt::FnDef { name, block: false });
            }
            // assignment lookahead
            if matches!(self.toks[self.pos + 1].tok, Tok::Op("=")) {
                let name = word.clone();
                self.pos += 2;
                return Ok(Stmt::Assign {
                    name,
                    expr: self.parse_expr()?,
                    line: t.line,
                });
            }
            if matches!(self.toks[self.pos + 1].tok, Tok::Op(":=")) {
                let name = word.clone();
                self.pos += 2;
                return Ok(Stmt::Reassign {
                    name,
                    expr: self.parse_expr()?,
                    line: t.line,
                });
            }
        }
        Ok(Stmt::Expr {
            expr: self.parse_expr()?,
        })
    }

    fn run(mut self) -> Result<Ast, String> {
        let mut stmts = Vec::new();
        self.skip_nl();
        while !matches!(self.peek().tok, Tok::Eof) {
            if matches!(self.peek().tok, Tok::Indent) {
                return Err(format!("line {}: unexpected indentation", self.peek().line));
            }
            if matches!(self.peek().tok, Tok::Dedent) {
                self.pos += 1;
                continue;
            }
            let st = self.parse_statement(true)?;
            let block_end = matches!(
                st,
                Stmt::If { .. }
                    | Stmt::For { .. }
                    | Stmt::While { .. }
                    | Stmt::Switch { .. }
                    | Stmt::FnDef { block: true, .. }
            );
            stmts.push(st);
            if !block_end && !matches!(self.peek().tok, Tok::Eof | Tok::Nl) {
                return Err(format!(
                    "line {}: unexpected '{}' after statement",
                    self.peek().line,
                    Self::tok_desc(&self.peek().tok)
                ));
            }
            self.skip_nl();
        }
        Ok(Ast {
            stmts,
            fns: self.fns,
        })
    }
}

pub fn parse(src: &str) -> Result<Ast, String> {
    let toks = Lexer::new(src).run()?;
    let ast = Parser {
        toks,
        pos: 0,
        uid: 0,
        depth: 0,
        fns: HashMap::new(),
    }
    .run()?;
    validate(&ast)?;
    Ok(ast)
}

// ------------------------------------------------------------- validation

pub const TOP_LEVEL_ONLY: [&str; 22] = [
    "study",
    "plot",
    "hline",
    "fill",
    "plotshape",
    "plotbuy",
    "plotsell",
    "infopanel",
    "barcolor",
    "bgcolor",
    "alertcondition",
    "strategy.config",
    "line.new",
    "label.new",
    "box.new",
    "security",
    "strategy.buy",
    "strategy.sell",
    "input",
    "input.int",
    "input.float",
    "input.time",
];
// input.bool / input.string are also restricted; kept as a fn for clarity
fn is_top_level_only(name: &str) -> bool {
    TOP_LEVEL_ONLY.contains(&name) || name == "input.bool" || name == "input.string"
}

fn walk_expr<'a>(e: &'a Expr, cb: &mut dyn FnMut(&'a Expr)) {
    if let Expr::Call { args, kwargs, .. } = e {
        cb(e);
        for a in args {
            walk_expr(a, cb);
        }
        for (_, v) in kwargs {
            walk_expr(v, cb);
        }
        return;
    }
    match e {
        Expr::Un { a, .. } => walk_expr(a, cb),
        Expr::Bin { a, b, .. } => {
            walk_expr(a, cb);
            walk_expr(b, cb);
        }
        Expr::Cond { c, a, b } => {
            walk_expr(c, cb);
            walk_expr(a, cb);
            walk_expr(b, cb);
        }
        Expr::Hist { base, off, .. } => {
            walk_expr(base, cb);
            walk_expr(off, cb);
        }
        _ => {}
    }
}

// expressions that evaluate exactly once per bar when the statement runs
fn exprs_of(st: &Stmt) -> Vec<&Expr> {
    match st {
        Stmt::Expr { expr }
        | Stmt::Assign { expr, .. }
        | Stmt::Reassign { expr, .. }
        | Stmt::VarDecl { expr, .. } => {
            vec![expr]
        }
        Stmt::If { cond, .. } => vec![cond],
        Stmt::For { from, to, by, .. } => {
            let mut v = vec![from, to];
            if let Some(b) = by {
                v.push(b);
            }
            v
        }
        Stmt::Switch { subject, .. } => vec![subject],
        Stmt::While { .. } | Stmt::FnDef { .. } | Stmt::Break { .. } | Stmt::Continue { .. } => {
            vec![]
        }
    }
}

// expressions that evaluate repeatedly (while conds, once per iteration) or
// conditionally (switch arm tests) — declaration calls in them would break
// every once-per-bar draw/input/order invariant, so validation treats them
// like block bodies
fn cond_exprs_of(st: &Stmt) -> Vec<&Expr> {
    match st {
        Stmt::While { cond, .. } => vec![cond],
        Stmt::Switch { arms, .. } => arms.iter().filter_map(|(test, _)| test.as_ref()).collect(),
        _ => vec![],
    }
}

// visit every call node under a statement list; `in_block` is true inside
// if/for bodies. The callback can abort with an error.
fn each_call<'a>(
    stmts: &'a [Stmt],
    in_block: bool,
    cb: &mut dyn FnMut(&'a Expr, bool) -> Result<(), String>,
) -> Result<(), String> {
    for st in stmts {
        for (exprs, blk) in [(exprs_of(st), in_block), (cond_exprs_of(st), true)] {
            for e in exprs {
                let mut err: Option<String> = None;
                walk_expr(e, &mut |call| {
                    if err.is_none() {
                        if let Err(msg) = cb(call, blk) {
                            err = Some(msg);
                        }
                    }
                });
                if let Some(msg) = err {
                    return Err(msg);
                }
            }
        }
        match st {
            Stmt::If { then, els, .. } => {
                each_call(then, true, cb)?;
                if let Some(e) = els {
                    each_call(e, true, cb)?;
                }
            }
            Stmt::For { body, .. } | Stmt::While { body, .. } => each_call(body, true, cb)?,
            Stmt::Switch { arms, .. } => {
                for (_, stmt) in arms {
                    each_call(std::slice::from_ref(stmt), true, cb)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

// every call node in a function (body statements + return expression)
fn each_fn_call<'a>(
    f: &'a FnDef,
    cb: &mut dyn FnMut(&'a Expr) -> Result<(), String>,
) -> Result<(), String> {
    each_call(&f.body, false, &mut |call, _| cb(call))?;
    let mut err: Option<String> = None;
    walk_expr(&f.ret, &mut |call| {
        if err.is_none() {
            if let Err(msg) = cb(call) {
                err = Some(msg);
            }
        }
    });
    match err {
        Some(msg) => Err(msg),
        None => Ok(()),
    }
}

// break/continue are only meaningful inside for/while bodies
fn check_loop_flow(list: &[Stmt], in_loop: bool) -> Result<(), String> {
    for st in list {
        match st {
            Stmt::Break { line } if !in_loop => {
                return Err(format!("line {}: 'break' outside of a loop", line))
            }
            Stmt::Continue { line } if !in_loop => {
                return Err(format!("line {}: 'continue' outside of a loop", line))
            }
            Stmt::If { then, els, .. } => {
                check_loop_flow(then, in_loop)?;
                if let Some(e) = els {
                    check_loop_flow(e, in_loop)?;
                }
            }
            Stmt::For { body, .. } | Stmt::While { body, .. } => check_loop_flow(body, true)?,
            Stmt::Switch { arms, .. } => {
                for (_, stmt) in arms {
                    check_loop_flow(std::slice::from_ref(stmt), in_loop)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub fn validate(ast: &Ast) -> Result<(), String> {
    check_loop_flow(&ast.stmts, false)?;
    for f in ast.fns.values() {
        check_loop_flow(&f.body, false)?;
    }
    each_call(&ast.stmts, false, &mut |call, in_block| {
        if let Expr::Call { name, line, .. } = call {
            if in_block && is_top_level_only(name) {
                return Err(format!(
                    "line {}: {}() must be at the top level of the script, not inside a block, while condition or switch arm",
                    line, name
                ));
            }
        }
        Ok(())
    })?;
    for (fname, f) in &ast.fns {
        each_fn_call(f, &mut |call| {
            if let Expr::Call { name, line, .. } = call {
                if is_top_level_only(name) {
                    return Err(format!(
                        "line {}: {}() is not allowed inside function '{}'",
                        line, name, fname
                    ));
                }
            }
            Ok(())
        })?;
    }
    // reject recursion over the user-function call graph
    fn visit(
        name: &str,
        from_line: usize,
        fns: &HashMap<String, FnDef>,
        visiting: &mut Vec<String>,
        done: &mut Vec<String>,
    ) -> Result<(), String> {
        if done.iter().any(|d| d == name) {
            return Ok(());
        }
        if visiting.iter().any(|v| v == name) {
            return Err(format!(
                "line {}: recursive function '{}' is not allowed",
                from_line, name
            ));
        }
        visiting.push(name.to_string());
        let mut called: Vec<(String, usize)> = Vec::new();
        each_fn_call(&fns[name], &mut |call| {
            if let Expr::Call { name: n, line, .. } = call {
                if fns.contains_key(n) {
                    called.push((n.clone(), *line));
                }
            }
            Ok(())
        })?;
        for (n, line) in called {
            visit(&n, line, fns, visiting, done)?;
        }
        visiting.pop();
        done.push(name.to_string());
        Ok(())
    }
    let mut visiting = Vec::new();
    let mut done = Vec::new();
    let names: Vec<String> = ast.fns.keys().cloned().collect();
    for n in names {
        let line = ast.fns[&n].line;
        visit(&n, line, &ast.fns, &mut visiting, &mut done)?;
    }
    // security(tf, expr) evaluates in another bar context — declarations and
    // nested security calls make no sense there
    each_call(&ast.stmts, false, &mut |call, _| {
        if let Expr::Call {
            name, args, kwargs, ..
        } = call
        {
            if name == "security" {
                let mut err: Option<String> = None;
                let mut check = |inner: &Expr| {
                    if let Expr::Call { name: n, line, .. } = inner {
                        if err.is_none() && TOP_LEVEL_ONLY.contains(&n.as_str()) {
                            err = Some(format!(
                                "line {}: {}() is not allowed inside security()",
                                line, n
                            ));
                        }
                    }
                };
                for a in args {
                    walk_expr(a, &mut check);
                }
                for (_, v) in kwargs {
                    walk_expr(v, &mut check);
                }
                if let Some(e) = err {
                    return Err(e);
                }
            }
        }
        Ok(())
    })?;
    Ok(())
}
