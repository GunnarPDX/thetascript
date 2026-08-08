// Language-surface constants shared by the wasm wrapper (index.js) and the
// JS interpreter — a separate module so importing them doesn't pull the
// whole interpreter into a consumer bundle.

// language/spec version (see SPEC.md) — bump on any observable behavior
// change so browser and backend implementations can be kept in lockstep
export const LANG_VERSION = '2.4.0';

// plot(...) draws — everything the evaluator dispatches specially plus the
// language keywords, exported for tooling (syntax highlighter, docs test)
export const DRAW_FN_NAMES = [
  'study', 'input', 'input.int', 'input.float', 'input.time', 'input.bool', 'input.string',
  'plot', 'hline', 'fill', 'plotshape', 'plotbuy', 'plotsell',
  'infopanel', 'barcolor', 'bgcolor', 'alertcondition',
  'strategy.buy', 'strategy.sell', 'strategy.config',
  'line.new', 'label.new', 'box.new', 'security',
];
export const KEYWORD_NAMES = ['and', 'or', 'not', 'true', 'false', 'na', 'var', 'if', 'else', 'for', 'to', 'by', 'while', 'switch', 'break', 'continue'];
