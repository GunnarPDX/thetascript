//! Per-bar evaluator — the Rust counterpart of js/src/interpreter.js.
//! Scopes, frames, history, draw-record collection with style locks, inputs,
//! alerts and the strategy engine, matching the reference bar for bar.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use serde_json::{Map, Value};

use crate::builtins::{make_builtin, Builtin};
use crate::jsmath::{js_max, js_min, js_number_to_string, js_round};
use crate::parse::{Ast, Expr, Stmt};
use crate::strategy::{Bar, StrategyEngine};
use crate::time::{epoch_from_wall, parse_timestamp, session_minutes, wall_parts};
use crate::value::{CallCtx, Val};
use chrono_tz::Tz;

const PLOT_COLORS: [&str; 6] = [
    "#22d3ee", "#f59e0b", "#a78bfa", "#22c55e", "#ec4899", "#38bdf8",
];
const PLOT_STYLES: [&str; 5] = ["line", "histogram", "area", "stepline", "circles"];
const LINE_STYLES: [&str; 3] = ["solid", "dashed", "dotted"];
const LOOP_LIMIT: usize = 100_000;

#[derive(PartialEq, Clone, Copy)]
pub enum Flow {
    Normal,
    Break,
    Continue,
}

pub struct BarData {
    pub date: f64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

pub struct Opts {
    pub inputs: Option<Map<String, Value>>,
    pub timezone: Option<String>,
    pub session_open: Option<String>,
    pub session_close: Option<String>,
}

// ---- draw records (typed so encoding reproduces the JS key sets) ---------

pub struct PlotRec {
    pub key: String,
    pub title: Val,
    pub color: Val,
    pub width: f64,
    pub style: String,
    pub line_style: String,
    pub color_span: Option<(usize, usize)>,
    pub width_span: Option<(usize, usize)>,
    pub values: Vec<f64>,
    pub is_hline: bool, // hline records carry no style/span keys
}

pub enum FillSide {
    Ref(usize),
    Vals(Vec<f64>),
}

pub struct FillRec {
    pub a: FillSide,
    pub b: FillSide,
    pub color: Val,
    pub opacity: f64,
}

pub struct ShapeRec {
    pub values: Vec<f64>,
    pub shape: Val,
    pub location: Val,
    pub color: Val,
    pub size: f64,
}

pub struct TradeRec {
    pub values: Vec<f64>,
    pub qty: Vec<f64>,
    pub side: &'static str,
    pub color: Val,
    pub price_source: &'static str,
    pub prices: Option<Vec<f64>>, // custom per-bar prices only
}

pub struct PanelRec {
    pub title: Val,
    pub value: Val,
    pub color: Val,
    pub precision: f64,
}

pub struct AlertRec {
    pub title: Val,
    pub message: Val,
    pub values: Vec<f64>,
    // per-fire rendered messages, only when the template has {{placeholders}}
    pub messages: Option<Vec<Option<String>>>,
}

pub struct BgRec {
    pub colors: Vec<Option<String>>,
    pub opacity: f64,
}

#[derive(Default)]
pub struct Out {
    pub title: Val,
    pub overlay: bool,
    pub description: Val,
    pub plots: Vec<PlotRec>,
    pub fills: Vec<FillRec>,
    pub shapes: Vec<ShapeRec>,
    pub trades: Vec<TradeRec>,
    pub panel: Vec<PanelRec>,
    pub bar_colors: Vec<Vec<Option<String>>>,
    pub bg_colors: Vec<BgRec>,
    pub inputs: Vec<Value>,
    pub alerts: Vec<AlertRec>,
    pub lines: Vec<LineRec>,
    pub labels: Vec<LabelRec>,
    pub boxes: Vec<BoxRec>,
}

pub struct LineRec {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub color: String,
    pub width: f64,
    pub line_style: String,
}

pub struct LabelRec {
    pub x: f64,
    pub y: f64,
    pub text: String,
    pub color: String,
    pub text_color: Option<String>,
    pub style: String,
    pub size: f64,
}

pub struct BoxRec {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub color: String,
    pub bg_color: Option<String>,
    pub width: f64,
}

// drawing objects cap: oldest dropped
pub const MAX_DRAW_OBJECTS: usize = 500;

pub fn push_capped<T>(arr: &mut Vec<T>, obj: T) {
    arr.push(obj);
    if arr.len() > MAX_DRAW_OBJECTS {
        arr.remove(0);
    }
}

// ---- slots & state -------------------------------------------------------

enum Slot {
    Src(Rc<Vec<f64>>),
    Const(f64),
    Dyn {
        value: Val,
        hist: Vec<Val>,
    },
    Per {
        decl_id: usize,
        value: Val,
        hist: Vec<Val>,
    },
}

enum State {
    Builtin(Builtin),
    HistBuf(Vec<Val>),
    BlockVar(Rc<RefCell<Val>>),
    Draw(DrawState),
    Security(SecState),
}

struct SecState {
    tf: String,
    spec: SecTf,
    bucket_key: f64,
    started: bool,
    agg: Option<AuxBar>,
    aux_bars: Vec<AuxBar>,
    value: Val,
}

#[derive(Default)]
pub struct DrawState {
    pub made: bool,
    pub locked: HashMap<&'static str, Val>,
    pub rec: usize,
    pub a_ref: Option<bool>,
    pub b_ref: Option<bool>,
    pub value: Val, // inputs: locked return value
}

pub fn lock(
    state: &mut DrawState,
    key: &'static str,
    val: Val,
    what: &str,
    line: usize,
) -> Result<Val, String> {
    match state.locked.get(key) {
        None => {
            state.locked.insert(key, val.clone());
            Ok(val)
        }
        Some(prev) => {
            if prev.object_is(&val) {
                Ok(prev.clone())
            } else {
                Err(format!(
                    "line {}: {} must not change between bars",
                    line, what
                ))
            }
        }
    }
}

pub fn lit_span(e: &Expr) -> Option<(usize, usize)> {
    match e {
        Expr::NumLit { span, .. } | Expr::StrLit { span, .. } => *span,
        _ => None,
    }
}

pub struct Engine<'a> {
    ast: &'a Ast,
    pub n: usize,
    bars: &'a [BarData],
    scope: HashMap<String, Slot>,
    commit_order: Vec<String>,
    // states keyed by (ctx id, kind, node id); kinds: 0 builtin, 1 hist
    // buffer, 2 draw, 3 block var. Ctx ids intern user-fn call paths so the
    // per-bar hot path never allocates strings
    states: HashMap<(usize, u8, usize), State>,
    ctx_id: usize,
    ctx_transitions: HashMap<(usize, usize), usize>,
    next_ctx: usize,
    pub strategy: StrategyEngine,
    frames: Vec<HashMap<String, Rc<RefCell<Val>>>>,
    // lexical barrier for user-function calls: read_var/reassign never scan
    // frames below this index, so a function body cannot see (or write) the
    // caller's block-locals — only its own frames, then the script scope
    frame_floor: usize,
    i: usize,
    decl_pass: bool,
    loop_iters: usize,
    cc: CallCtx,
    inputs: Option<Map<String, Value>>,
    tz: Tz,
    // active security() sub-context: (aux bars, current aux index)
    sec_bars: Option<(Vec<AuxBar>, usize)>,
    pub out: Out,
}

#[derive(Clone, Copy)]
pub struct AuxBar {
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub time: f64,
}

fn sec_source(bar: &AuxBar, name: &str, idx: usize) -> f64 {
    match name {
        "open" => bar.open,
        "high" => bar.high,
        "low" => bar.low,
        "close" => bar.close,
        "volume" => bar.volume,
        "time" => bar.time,
        "bar_index" => idx as f64,
        "hl2" => (bar.high + bar.low) / 2.0,
        "hlc3" => (bar.high + bar.low + bar.close) / 3.0,
        "ohlc4" => (bar.open + bar.high + bar.low + bar.close) / 4.0,
        _ => f64::NAN,
    }
}

enum SecTf {
    BucketMs(f64),
    Anchor(&'static str),
}

fn parse_security_tf(tf: &str, line: usize) -> Result<SecTf, String> {
    let b: Vec<char> = tf.chars().collect();
    let digits: String = b.iter().take_while(|c| c.is_ascii_digit()).collect();
    let rest: String = b.iter().skip(digits.len()).collect();
    let count: f64 = digits.parse().unwrap_or(0.0);
    if digits.is_empty() || rest.len() != 1 || count <= 0.0 {
        return Err(format!(
            "line {}: security timeframe must look like \"5m\", \"1h\", \"1d\" or \"1w\"",
            line
        ));
    }
    match rest.as_str() {
        "m" => Ok(SecTf::BucketMs(count * 60_000.0)),
        "h" => Ok(SecTf::BucketMs(count * 3_600_000.0)),
        "d" | "w" => {
            if count != 1.0 {
                return Err(format!(
                    "line {}: security day/week timeframes must be \"1d\" or \"1w\"",
                    line
                ));
            }
            Ok(SecTf::Anchor(if rest == "d" { "session" } else { "week" }))
        }
        _ => Err(format!(
            "line {}: security timeframe must look like \"5m\", \"1h\", \"1d\" or \"1w\"",
            line
        )),
    }
}

impl<'a> Engine<'a> {
    pub fn new(ast: &'a Ast, bars: &'a [BarData], tz: Tz, opts: Opts) -> Self {
        let n = bars.len();
        let mut scope: HashMap<String, Slot> = HashMap::new();
        let arr = |f: fn(&BarData) -> f64| Rc::new(bars.iter().map(f).collect::<Vec<f64>>());
        scope.insert("open".into(), Slot::Src(arr(|b| b.open)));
        scope.insert("high".into(), Slot::Src(arr(|b| b.high)));
        scope.insert("low".into(), Slot::Src(arr(|b| b.low)));
        scope.insert("close".into(), Slot::Src(arr(|b| b.close)));
        scope.insert("volume".into(), Slot::Src(arr(|b| b.volume)));
        scope.insert(
            "bar_index".into(),
            Slot::Src(Rc::new((0..n).map(|i| i as f64).collect())),
        );
        scope.insert("time".into(), Slot::Src(arr(|b| b.date)));
        scope.insert("hl2".into(), Slot::Src(arr(|b| (b.high + b.low) / 2.0)));
        scope.insert(
            "hlc3".into(),
            Slot::Src(arr(|b| (b.high + b.low + b.close) / 3.0)),
        );
        scope.insert(
            "ohlc4".into(),
            Slot::Src(arr(|b| (b.open + b.high + b.low + b.close) / 4.0)),
        );

        let cur = if n > 0 { bars[n - 1].date } else { f64::NAN };
        let open_m = session_minutes(opts.session_open.as_deref(), 570.0);
        let close_m = session_minutes(opts.session_close.as_deref(), 960.0);
        let (today, mkt_open, mkt_close) = if cur.is_nan() {
            (f64::NAN, f64::NAN, f64::NAN)
        } else {
            match wall_parts(cur, tz) {
                Some((y, mo, d, ..)) => (
                    epoch_from_wall(y, mo, d, 0.0, 0.0, tz),
                    epoch_from_wall(y, mo, d, (open_m / 60.0).floor(), open_m % 60.0, tz),
                    epoch_from_wall(y, mo, d, (close_m / 60.0).floor(), close_m % 60.0, tz),
                ),
                None => (f64::NAN, f64::NAN, f64::NAN),
            }
        };
        scope.insert("pi".into(), Slot::Const(std::f64::consts::PI));
        scope.insert("current_datetime".into(), Slot::Const(cur));
        scope.insert("date_today".into(), Slot::Const(today));
        scope.insert("market_open".into(), Slot::Const(mkt_open));
        scope.insert("market_close".into(), Slot::Const(mkt_close));
        for name in [
            "barstate.isfirst",
            "barstate.islast",
            "strategy.position_size",
            "strategy.avg_price",
            "strategy.open_pnl",
            "strategy.realized_pnl",
            "strategy.equity",
            "strategy.trades",
            "strategy.wins",
            "strategy.losses",
        ] {
            scope.insert(name.into(), Slot::Const(f64::NAN));
        }

        let out = Out {
            overlay: true,
            ..Out::default()
        };

        Engine {
            ast,
            n,
            bars,
            scope,
            commit_order: Vec::new(),
            states: HashMap::new(),
            ctx_id: 0,
            ctx_transitions: HashMap::new(),
            next_ctx: 1,
            sec_bars: None,
            strategy: StrategyEngine::new(n),
            frames: Vec::new(),
            frame_floor: 0,
            i: 0,
            decl_pass: false,
            loop_iters: 0,
            cc: CallCtx::new(tz),
            inputs: opts.inputs,
            tz,
            out,
        }
    }

    fn set_const(&mut self, name: &str, v: f64) {
        if let Some(Slot::Const(slot)) = self.scope.get_mut(name) {
            *slot = v;
        }
    }

    pub fn run(&mut self) -> Result<(), String> {
        if self.n == 0 {
            // declaration pass: sources read na, no per-bar collection
            self.decl_pass = true;
            self.cc.reset_bar(
                0,
                f64::NAN,
                f64::NAN,
                f64::NAN,
                f64::NAN,
                f64::NAN,
                f64::NAN,
            );
            for (name, v) in self.strategy.sources(f64::NAN) {
                self.set_const(name, v);
            }
            self.exec_all()?;
            return Ok(());
        }
        for i in 0..self.n {
            self.i = i;
            let b = &self.bars[i];
            self.cc
                .reset_bar(i, b.open, b.high, b.low, b.close, b.volume, b.date);
            self.loop_iters = 0;
            let bar = Bar {
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
            };
            self.strategy.pre_bar(i, &bar);
            self.set_const("barstate.isfirst", if i == 0 { 1.0 } else { 0.0 });
            self.set_const("barstate.islast", if i == self.n - 1 { 1.0 } else { 0.0 });
            for (name, v) in self.strategy.sources(b.close) {
                self.set_const(name, v);
            }
            self.exec_all()?;
            self.strategy.post_bar(i, &bar);
            for k in 0..self.commit_order.len() {
                let name = self.commit_order[k].clone();
                if let Some(Slot::Dyn { value, hist } | Slot::Per { value, hist, .. }) =
                    self.scope.get_mut(&name)
                {
                    hist[i] = value.clone();
                }
            }
        }
        Ok(())
    }

    fn exec_all(&mut self) -> Result<(), String> {
        // clone of statement list is avoided by indexing into the ast
        for st in &self.ast.stmts {
            self.exec_stmt(st)?;
        }
        Ok(())
    }

    fn exec_stmt(&mut self, st: &'a Stmt) -> Result<Flow, String> {
        match st {
            Stmt::Expr { expr } => {
                self.eval(expr)?;
                Ok(Flow::Normal)
            }
            Stmt::Assign { name, expr, line } => {
                let v = self.eval(expr)?;
                if let Some(frame) = self.frames.last_mut() {
                    frame.insert(name.clone(), Rc::new(RefCell::new(v)));
                    return Ok(Flow::Normal);
                }
                match self.scope.get_mut(name) {
                    Some(Slot::Src(_)) | Some(Slot::Const(_)) => Err(format!(
                        "line {}: cannot assign to built-in source '{}'",
                        line, name
                    )),
                    Some(Slot::Per { .. }) => Err(format!(
                        "line {}: '{}' is declared with var — use := to reassign it",
                        line, name
                    )),
                    Some(Slot::Dyn { value, .. }) => {
                        *value = v;
                        Ok(Flow::Normal)
                    }
                    None => {
                        self.scope.insert(
                            name.clone(),
                            Slot::Dyn {
                                value: v,
                                hist: vec![Val::nan(); self.n],
                            },
                        );
                        self.commit_order.push(name.clone());
                        Ok(Flow::Normal)
                    }
                }
            }
            Stmt::Reassign { name, expr, line } => {
                let v = self.eval(expr)?;
                for f in self.frames[self.frame_floor..].iter().rev() {
                    if let Some(cell) = f.get(name) {
                        *cell.borrow_mut() = v;
                        return Ok(Flow::Normal);
                    }
                }
                match self.scope.get_mut(name) {
                    None => Err(format!(
                        "line {}: cannot reassign undeclared variable '{}'",
                        line, name
                    )),
                    Some(Slot::Src(_)) | Some(Slot::Const(_)) => Err(format!(
                        "line {}: cannot reassign built-in '{}'",
                        line, name
                    )),
                    Some(Slot::Dyn { value, .. }) | Some(Slot::Per { value, .. }) => {
                        *value = v;
                        Ok(Flow::Normal)
                    }
                }
            }
            Stmt::VarDecl {
                id,
                name,
                expr,
                line,
            } => {
                if !self.frames.is_empty() {
                    let key = (self.ctx_id, 3u8, *id);
                    let cell = if let Some(State::BlockVar(cell)) = self.states.get(&key) {
                        cell.clone()
                    } else {
                        let v = self.eval(expr)?;
                        let cell = Rc::new(RefCell::new(v));
                        self.states.insert(key, State::BlockVar(cell.clone()));
                        cell
                    };
                    self.frames.last_mut().unwrap().insert(name.clone(), cell);
                    return Ok(Flow::Normal);
                }
                match self.scope.get(name) {
                    Some(Slot::Per { decl_id, .. }) => {
                        if *decl_id != *id {
                            return Err(format!(
                                "line {}: variable '{}' is already declared",
                                line, name
                            ));
                        }
                        return Ok(Flow::Normal); // later bar — init runs once
                    }
                    Some(Slot::Src(_)) | Some(Slot::Const(_)) => {
                        return Err(format!(
                            "line {}: cannot declare over built-in source '{}'",
                            line, name
                        ));
                    }
                    Some(Slot::Dyn { .. }) => {
                        // a plain `x = …` earlier in the script already owns
                        // the name — erroring immediately keeps the error
                        // independent of bar count
                        return Err(format!(
                            "line {}: variable '{}' is already declared",
                            line, name
                        ));
                    }
                    None => {}
                }
                let v = self.eval(expr)?;
                self.scope.insert(
                    name.clone(),
                    Slot::Per {
                        decl_id: *id,
                        value: v,
                        hist: vec![Val::nan(); self.n],
                    },
                );
                self.commit_order.push(name.clone());
                Ok(Flow::Normal)
            }
            Stmt::If { cond, then, els } => {
                let c = self.eval(cond)?;
                let branch = if c.truthy() { Some(then) } else { els.as_ref() };
                match branch {
                    Some(stmts) => self.exec_block(stmts),
                    None => Ok(Flow::Normal),
                }
            }
            Stmt::While { cond, body, line } => loop {
                if !self.eval(cond)?.truthy() {
                    return Ok(Flow::Normal);
                }
                self.loop_iters += 1;
                if self.loop_iters > LOOP_LIMIT {
                    return Err(format!("line {}: loop iteration limit exceeded", line));
                }
                if self.exec_block(body)? == Flow::Break {
                    return Ok(Flow::Normal);
                }
            },
            Stmt::Switch { subject, arms, .. } => {
                // tests evaluate in order until one matches; the matched
                // arm's statement runs, then done
                let subject = self.eval(subject)?;
                for (test, stmt) in arms {
                    match test {
                        None => return self.exec_stmt(stmt),
                        Some(t) => {
                            let tv = self.eval(t)?;
                            if subject.strict_eq(&tv) {
                                return self.exec_stmt(stmt);
                            }
                        }
                    }
                }
                Ok(Flow::Normal)
            }
            Stmt::Break { .. } => Ok(Flow::Break),
            Stmt::Continue { .. } => Ok(Flow::Continue),
            Stmt::For {
                name,
                from,
                to,
                by,
                body,
                line,
            } => {
                let from_v = self.eval(from)?;
                let to_v = self.eval(to)?;
                let by_v = match by {
                    Some(e) => self.eval(e)?,
                    None => Val::Num(1.0),
                };
                let (Val::Num(from), Val::Num(to), Val::Num(step)) = (&from_v, &to_v, &by_v) else {
                    return Err(format!("line {}: for loop bounds must be numbers", line));
                };
                let (from, to, step) = (*from, *to, *step);
                if step == 0.0 {
                    return Err(format!("line {}: for loop step must not be zero", line));
                }
                let cell = Rc::new(RefCell::new(Val::Num(from)));
                let mut frame = HashMap::new();
                frame.insert(name.clone(), cell.clone());
                self.frames.push(frame);
                let mut v = from;
                let result = 'outer: loop {
                    let cont = if step > 0.0 { v <= to } else { v >= to };
                    if !cont {
                        break Ok(Flow::Normal);
                    }
                    self.loop_iters += 1;
                    if self.loop_iters > LOOP_LIMIT {
                        break Err(format!("line {}: loop iteration limit exceeded", line));
                    }
                    *cell.borrow_mut() = Val::Num(v);
                    for st in body {
                        match self.exec_stmt(st) {
                            Err(e) => break 'outer Err(e),
                            Ok(Flow::Break) => break 'outer Ok(Flow::Normal),
                            Ok(Flow::Continue) => break,
                            Ok(Flow::Normal) => {}
                        }
                    }
                    v += step;
                };
                self.frames.pop();
                result
            }
            Stmt::FnDef { .. } => Ok(Flow::Normal),
        }
    }

    fn exec_block(&mut self, stmts: &'a [Stmt]) -> Result<Flow, String> {
        self.frames.push(HashMap::new());
        let mut result = Ok(Flow::Normal);
        for st in stmts {
            match self.exec_stmt(st) {
                Err(e) => {
                    result = Err(e);
                    break;
                }
                Ok(Flow::Normal) => {}
                Ok(sig) => {
                    result = Ok(sig);
                    break;
                }
            }
        }
        self.frames.pop();
        result
    }

    fn read_var(&self, name: &str, line: usize) -> Result<Val, String> {
        for f in self.frames[self.frame_floor..].iter().rev() {
            if let Some(cell) = f.get(name) {
                return Ok(cell.borrow().clone());
            }
        }
        match self.scope.get(name) {
            Some(Slot::Src(arr)) => {
                if let Some((bars, idx)) = &self.sec_bars {
                    return Ok(Val::Num(sec_source(&bars[*idx], name, *idx)));
                }
                Ok(Val::Num(if self.decl_pass {
                    f64::NAN
                } else {
                    arr[self.i]
                }))
            }
            Some(Slot::Const(v)) => Ok(Val::Num(*v)),
            Some(Slot::Dyn { value, .. }) | Some(Slot::Per { value, .. }) => Ok(value.clone()),
            None => Err(format!("line {}: unknown variable '{}'", line, name)),
        }
    }

    fn to_js_string(v: &Val) -> String {
        match v {
            Val::Num(n) => js_number_to_string(*n),
            Val::Str(s) => s.clone(),
            Val::Ref(_) => "[object Object]".into(),
            Val::Arr(_) => "[array]".into(),
            Val::Null => "null".into(),
        }
    }

    pub fn eval(&mut self, e: &'a Expr) -> Result<Val, String> {
        match e {
            Expr::NumLit { v, .. } => Ok(Val::Num(*v)),
            Expr::StrLit { v, .. } => Ok(Val::Str(v.clone())),
            Expr::Var { name, line } => self.read_var(name, *line),
            Expr::Un { op, a } => {
                let v = self.eval(a)?;
                Ok(match *op {
                    "-" => Val::Num(-v.num()),
                    _ => Val::Num(if v.truthy() { 0.0 } else { 1.0 }),
                })
            }
            Expr::Bin { op, a, b } => {
                let av = self.eval(a)?;
                let bv = self.eval(b)?;
                let r = match *op {
                    "+" => {
                        if matches!(av, Val::Str(_)) || matches!(bv, Val::Str(_)) {
                            Val::Str(format!(
                                "{}{}",
                                Self::to_js_string(&av),
                                Self::to_js_string(&bv)
                            ))
                        } else {
                            Val::Num(av.num() + bv.num())
                        }
                    }
                    "-" => Val::Num(av.num() - bv.num()),
                    "*" => Val::Num(av.num() * bv.num()),
                    "/" => Val::Num(av.num() / bv.num()),
                    "%" => Val::Num(av.num() % bv.num()),
                    "<" => Val::Num(if av.num() < bv.num() { 1.0 } else { 0.0 }),
                    "<=" => Val::Num(if av.num() <= bv.num() { 1.0 } else { 0.0 }),
                    ">" => Val::Num(if av.num() > bv.num() { 1.0 } else { 0.0 }),
                    ">=" => Val::Num(if av.num() >= bv.num() { 1.0 } else { 0.0 }),
                    "==" => Val::Num(if av.strict_eq(&bv) { 1.0 } else { 0.0 }),
                    "!=" => Val::Num(if av.strict_eq(&bv) { 0.0 } else { 1.0 }),
                    "and" => Val::Num(if av.truthy() && bv.truthy() { 1.0 } else { 0.0 }),
                    "or" => Val::Num(if av.truthy() || bv.truthy() { 1.0 } else { 0.0 }),
                    _ => return Err("bad operator".into()),
                };
                Ok(r)
            }
            Expr::Cond { c, a, b } => {
                // all three evaluate every bar; only the value is selected
                let cv = self.eval(c)?;
                let av = self.eval(a)?;
                let bv = self.eval(b)?;
                Ok(if cv.truthy() { av } else { bv })
            }
            Expr::Hist {
                id,
                base,
                off,
                line,
            } => self.eval_hist(*id, base, off, *line),
            Expr::Call {
                id,
                name,
                args,
                kwargs,
                line,
            } => self.eval_call(*id, name, args, kwargs, *line),
        }
    }

    fn eval_hist(
        &mut self,
        id: usize,
        base: &'a Expr,
        off: &'a Expr,
        line: usize,
    ) -> Result<Val, String> {
        let off_v = self.eval(off)?;
        let Val::Num(off_n) = off_v else {
            return Err(format!("line {}: history offset must be a number", line));
        };
        let o = js_round(off_n);
        let idx = self.sec_bars.as_ref().map(|(_, i)| *i).unwrap_or(self.i);
        if let Expr::Var { name, line } = base {
            let frame_local = self.frames.iter().rev().any(|f| f.contains_key(name));
            if !frame_local {
                let in_range = o >= 0.0 && idx as f64 - o >= 0.0;
                return match self.scope.get(name) {
                    None => Err(format!("line {}: unknown variable '{}'", line, name)),
                    _ if self.decl_pass => Ok(Val::nan()),
                    _ if !in_range => Ok(Val::nan()),
                    Some(Slot::Src(arr)) => {
                        let j = (idx as f64 - o) as usize;
                        if let Some((bars, _)) = &self.sec_bars {
                            return Ok(Val::Num(sec_source(&bars[j], name, j)));
                        }
                        Ok(Val::Num(arr[j]))
                    }
                    Some(Slot::Const(v)) => Ok(Val::Num(*v)), // scalars broadcast
                    Some(Slot::Dyn { value, hist }) | Some(Slot::Per { value, hist, .. }) => {
                        if o == 0.0 {
                            Ok(value.clone())
                        } else {
                            Ok(hist[(idx as f64 - o) as usize].clone())
                        }
                    }
                };
            }
        }
        // arbitrary-expression history: per-call-site buffer
        let v = self.eval(base)?;
        if self.decl_pass {
            return Ok(if o == 0.0 { v } else { Val::nan() });
        }
        let key = (self.ctx_id, 1u8, id);
        let n = self.n;
        let buf = match self
            .states
            .entry(key)
            .or_insert_with(|| State::HistBuf(vec![Val::nan(); n]))
        {
            State::HistBuf(b) => b,
            _ => return Err("state clash".into()),
        };
        buf[idx] = v;
        // NaN offsets must fail this guard — hence the negated >=, not <
        #[allow(clippy::neg_cmp_op_on_partial_ord)]
        if !(o >= 0.0) || idx as f64 - o < 0.0 {
            return Ok(Val::nan());
        }
        Ok(buf[(idx as f64 - o) as usize].clone())
    }

    // security(tf, expr): aggregate chart bars into tf buckets and evaluate
    // the expression once per CONFIRMED bucket, in a sub-context where the
    // sources read the aggregated bar. Non-repainting by construction.
    fn eval_security(
        &mut self,
        id: usize,
        arg_nodes: &'a [Expr],
        line: usize,
    ) -> Result<Val, String> {
        if arg_nodes.len() < 2 {
            return Err(format!(
                "line {}: security needs a timeframe and an expression",
                line
            ));
        }
        let tf_v = self.eval(&arg_nodes[0])?;
        let key = (self.ctx_id, 4u8, id);
        if let std::collections::hash_map::Entry::Vacant(e) = self.states.entry(key) {
            let Val::Str(tf) = &tf_v else {
                return Err(format!(
                    "line {}: security timeframe must be a string",
                    line
                ));
            };
            let spec = parse_security_tf(tf, line)?;
            e.insert(State::Security(SecState {
                tf: tf.clone(),
                spec,
                bucket_key: f64::NAN,
                started: false,
                agg: None,
                aux_bars: Vec::new(),
                value: Val::nan(),
            }));
        }
        // locked timeframe
        {
            let Some(State::Security(st)) = self.states.get(&key) else {
                return Err("state clash".into());
            };
            match &tf_v {
                Val::Str(tf) if *tf == st.tf => {}
                _ => {
                    return Err(format!(
                        "line {}: security timeframe must not change between bars",
                        line
                    ))
                }
            }
        }
        if self.decl_pass {
            return Ok(Val::nan());
        }
        let bar = &self.bars[self.i];
        let t = bar.date;
        // compute bucket key without holding the state borrow
        let bucket = {
            let Some(State::Security(st)) = self.states.get(&key) else {
                return Err("state clash".into());
            };
            match st.spec {
                SecTf::BucketMs(ms) => (t / ms).floor(),
                SecTf::Anchor(a) => self.cc.anchor_key(a),
            }
        };
        let mut confirmed: Option<Vec<AuxBar>> = None;
        {
            let Some(State::Security(st)) = self.states.get_mut(&key) else {
                return Err("state clash".into());
            };
            if !st.started {
                st.started = true;
                st.bucket_key = bucket;
                st.agg = Some(AuxBar {
                    open: bar.open,
                    high: bar.high,
                    low: bar.low,
                    close: bar.close,
                    volume: bar.volume,
                    time: t,
                });
            } else if bucket != st.bucket_key {
                if let Some(agg) = st.agg.take() {
                    st.aux_bars.push(agg);
                }
                confirmed = Some(st.aux_bars.clone());
                st.bucket_key = bucket;
                st.agg = Some(AuxBar {
                    open: bar.open,
                    high: bar.high,
                    low: bar.low,
                    close: bar.close,
                    volume: bar.volume,
                    time: t,
                });
            } else if let Some(a) = &mut st.agg {
                if bar.high > a.high {
                    a.high = bar.high;
                }
                if bar.low < a.low {
                    a.low = bar.low;
                }
                a.close = bar.close;
                a.volume += bar.volume;
            }
        }
        if let Some(aux) = confirmed {
            let v = self.eval_in_security_ctx(id, &arg_nodes[1], aux)?;
            if let Some(State::Security(st)) = self.states.get_mut(&key) {
                st.value = v;
            }
        }
        let Some(State::Security(st)) = self.states.get(&key) else {
            return Err("state clash".into());
        };
        Ok(st.value.clone())
    }

    fn eval_in_security_ctx(
        &mut self,
        id: usize,
        expr: &'a Expr,
        aux: Vec<AuxBar>,
    ) -> Result<Val, String> {
        let idx = aux.len() - 1;
        let cur = aux[idx];
        let prev_sec = self.sec_bars.take();
        let prev_ctx = self.ctx_id;
        // security sub-contexts intern like user-fn calls, with a disjoint slot
        let next = self.next_ctx;
        let ctx = *self
            .ctx_transitions
            .entry((prev_ctx, id + 1_000_000))
            .or_insert(next);
        if ctx == next {
            self.next_ctx += 1;
        }
        self.ctx_id = ctx;
        self.sec_bars = Some((aux, idx));
        let saved = self.cc.save_bar();
        self.cc.reset_bar(
            idx, cur.open, cur.high, cur.low, cur.close, cur.volume, cur.time,
        );
        let result = self.eval(expr);
        self.cc.restore_bar(saved);
        self.sec_bars = prev_sec;
        self.ctx_id = prev_ctx;
        result
    }

    fn eval_call(
        &mut self,
        id: usize,
        name: &'a str,
        arg_nodes: &'a [Expr],
        kwarg_nodes: &'a [(String, Expr)],
        line: usize,
    ) -> Result<Val, String> {
        if name == "security" {
            return self.eval_security(id, arg_nodes, line);
        }
        // kwargs evaluate before positional args, like the reference
        let mut kwargs: Vec<(&'a str, Val)> = Vec::with_capacity(kwarg_nodes.len());
        for (k, e) in kwarg_nodes {
            kwargs.push((k.as_str(), self.eval(e)?));
        }
        let mut args: Vec<Val> = Vec::with_capacity(arg_nodes.len());
        for a in arg_nodes {
            args.push(self.eval(a)?);
        }
        if let Some(fndef) = self.ast.fns.get(name) {
            if !kwargs.is_empty() {
                return Err(format!(
                    "line {}: {}() takes positional arguments only",
                    line, name
                ));
            }
            if args.len() != fndef.params.len() {
                return Err(format!(
                    "line {}: {}() expects {} argument{}, got {}",
                    line,
                    name,
                    fndef.params.len(),
                    if fndef.params.len() == 1 { "" } else { "s" },
                    args.len()
                ));
            }
            let mut frame = HashMap::new();
            for (p, v) in fndef.params.iter().zip(args) {
                frame.insert(p.clone(), Rc::new(RefCell::new(v)));
            }
            let prev_floor = self.frame_floor;
            self.frame_floor = self.frames.len(); // the param frame stays visible
            self.frames.push(frame);
            let prev = self.ctx_id;
            let next = self.next_ctx;
            let ctx = *self.ctx_transitions.entry((prev, id)).or_insert(next);
            if ctx == next {
                self.next_ctx += 1;
            }
            self.ctx_id = ctx;
            let mut result = Ok(Val::nan());
            for st in &fndef.body {
                if let Err(e) = self.exec_stmt(st) {
                    result = Err(e);
                    break;
                }
            }
            if result.is_ok() {
                result = self.eval(&fndef.ret);
            }
            self.ctx_id = prev;
            self.frames.pop();
            self.frame_floor = prev_floor;
            return result;
        }
        if crate::draw::is_draw_fn(name) {
            return crate::draw::handle(
                self,
                id,
                name,
                arg_nodes,
                kwarg_nodes,
                &args,
                &kwargs,
                line,
            );
        }
        let key = (self.ctx_id, 0u8, id);
        if let std::collections::hash_map::Entry::Vacant(slot) = self.states.entry(key) {
            match make_builtin(name) {
                Some(b) => {
                    slot.insert(State::Builtin(b));
                }
                None => return Err(format!("line {}: unknown function '{}'", line, name)),
            }
        }
        let Some(State::Builtin(inst)) = self.states.get_mut(&key) else {
            return Err("state clash".into());
        };
        inst(&self.cc, &args)
    }

    // ---- accessors used by the draw module -------------------------------

    pub fn decl_pass(&self) -> bool {
        self.decl_pass
    }

    pub fn bar_index(&self) -> usize {
        self.i
    }

    /// (open, high, low, close, volume, time) of the current chart bar
    pub fn bar_fields(&self) -> (f64, f64, f64, f64, f64, f64) {
        let b = &self.bars[self.i];
        (b.open, b.high, b.low, b.close, b.volume, b.date)
    }

    pub fn current_bar(&self) -> Bar {
        let b = &self.bars[self.i];
        Bar {
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
        }
    }

    pub fn timezone(&self) -> Tz {
        self.tz
    }

    pub fn input_override(&self, key: &str) -> Option<&Value> {
        self.inputs.as_ref().and_then(|m| m.get(key))
    }

    /// take the draw state for a call site out of the state map (put it back
    /// with put_draw_state) — avoids holding a states borrow while the
    /// handler mutates the output collections
    pub fn take_draw_state(&mut self, id: usize) -> DrawState {
        match self.states.remove(&(0, 2u8, id)) {
            Some(State::Draw(d)) => d,
            _ => DrawState::default(),
        }
    }

    pub fn put_draw_state(&mut self, id: usize, ds: DrawState) {
        self.states.insert((0, 2u8, id), State::Draw(ds));
    }
}

pub fn clamp_precision(p: f64) -> f64 {
    js_max(0.0, js_min(8.0, js_round(p)))
}

pub fn plot_palette(idx: usize) -> &'static str {
    PLOT_COLORS[idx % PLOT_COLORS.len()]
}

pub fn valid_plot_style(s: &str) -> bool {
    PLOT_STYLES.contains(&s)
}

pub fn valid_line_style(s: &str) -> bool {
    LINE_STYLES.contains(&s)
}

pub fn parse_ts(s: &str, tz: Tz) -> f64 {
    parse_timestamp(s, tz)
}
