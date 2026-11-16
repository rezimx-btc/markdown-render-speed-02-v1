// parse.js — dependency-free Markdown-to-HTML renderer matching marked 18.1.3
// (default options: GFM on, breaks off, pedantic off, async off) byte for byte
// on the CommonMark 0.31.2 + GFM 0.29 example set and on long generated
// documents. Written fresh for make.fun markdown-render-speed-02.
//
// Design: one left-to-right block scan emits HTML fragments straight into an
// output list (no token tree, no second pass over blocks). Inline runs are
// queued as small jobs while blocks are scanned — link definitions are only
// complete once the whole document has been scanned — and rendered afterwards
// in the order they were queued. Regular expressions are sticky (y flag) and
// driven by an explicit cursor, so the scanner never slices the input.
//
// Every parse() call starts from a clean slate: fresh definitions, fresh
// jobs, no memo of any earlier call.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML metacharacters in `s`. With `all`, every `&` is escaped; without
// it, an `&` that begins a character reference is left alone.
function esc(s, all) {
  if (all) {
    return /[&<>"']/.test(s) ? s.replace(/[&<>"']/g, (c) => ESC[c]) : s;
  }
  return /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/.test(s)
    ? s.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (c) => ESC[c])
    : s;
}

const NUM_REF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_ALL = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Turn numeric character references in `s` into characters (invalid code
// points become U+FFFD); a bare `&` that is not a reference becomes `&amp;`.
function decodeRefs(s) {
  if (!NUM_REF_TEST.test(s)) return s;
  return s.replace(NUM_REF_ALL, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    return cp === 38 ? '&amp;' : String.fromCodePoint(cp);
  });
}

// Percent-encode a link destination the way marked does, keeping `%` alone.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

function stripTrailing(s, ch) {
  let n = s.length;
  while (n > 0 && s[n - 1] === ch) n--;
  return s.slice(0, n);
}

// Drop trailing blank lines from a block, unless there are at most two.
function dropTrailingBlanks(s) {
  const lines = s.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return s;
  return lines.slice(0, end + 1).join('\n');
}

// Normalise a link label so a definition and a reference use the same key.
function labelKey(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the bracket closing the one opened before `s`, counting nesting
// and skipping backslash escapes. -1: no closer; -2: opens outnumber closes.
function closingBracket(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (ch === pair[0]) depth++;
    else if (ch === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

function expandTabs(line, indent) {
  let col = indent || 0;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const add = 4 - (col % 4);
      out += ' '.repeat(add);
      col += add;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Split a table row on unescaped pipes, padding/truncating to `count` cells.
function splitRow(rowText, count) {
  const markedRow = rowText.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let cur = offset;
    while (--cur >= 0 && str[cur] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = markedRow.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1).trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ---------------------------------------------------------------------------
// Block grammar. The patterns are marked 18.1.3's block grammar, rebuilt as
// sticky expressions so the scanner can run each one at its cursor. `sy`
// drops the leading ^ (stickiness anchors already) and adds the y flag;
// $ still means end of the scanned string, exactly as in the reference.
// ---------------------------------------------------------------------------

const TAGNAMES = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

const COMMENT_PAT = '<!--(?:-?>|[\\s\\S]*?(?:-->|$))';
const HR_PAT = '(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,}';
const MARKER_PAT = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';

function sy(source, flags) {
  return new RegExp(source, (flags || '') + 'y');
}

const B = {
  newline: sy('(?:[ \\t]*(?:\\n|$))+'),
  code: sy('((?: {4}| {0,3}\\t)[^\\n]+(?:\\n(?:[ \\t]*(?:\\n|$))*)?)+'),
  fences: sy(' {0,3}(`{3,}(?=[^`\\n]*(?:\\n|$))|~{3,})([^\\n]*)(?:\\n|$)'
    + '(?:|([\\s\\S]*?)(?:\\n|$))(?: {0,3}(?:(?=`)\\1`*|(?=~)\\1~*) *(?=\\n|$)|$)'),
  hr: sy(' {0,3}(' + HR_PAT + ')(?:\\n+|$)'),
  heading: sy(' {0,3}(#{1,6})(?=\\s|$)(.*)(?:\\n+|$)'),
  list: sy('(' + MARKER_PAT + ')([ \\t][^\\n]*?)?(?:\\n|$)'),
  text: sy('[^\\n]+'),
  def: null,
  lheading: null,
  paragraph: null,
  table: null,
  html: null,
  blockquote: null,
};

const LABEL_BODY = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const TITLE_PAT = '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))';

B.def = sy(' {0,3}\\[(' + LABEL_BODY + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)'
  + '(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(' + TITLE_PAT + '))? *(?:\\n+|$)');

const SETEXT_CORE = '(?!MARKER |INDENTCODE|FENCE|QUOTE|ATX|HTMLBLOCK|TABLEPAT)'
  + '((?:.|\\n(?!\\s*?\\n|MARKER |FENCE|QUOTE|ATX|HRPAT|HTMLBLOCK|TABLEPAT))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
function setextRx(withTable) {
  return sy(SETEXT_CORE
    .replace(/MARKER /g, MARKER_PAT + ' ')
    .replace(/INDENTCODE/g, '(?: {4}| {0,3}\\t)')
    .replace(/FENCE/g, ' {0,3}(?:`{3,}|~{3,})')
    .replace(/QUOTE/g, ' {0,3}>')
    .replace(/ATX/g, ' {0,3}#{1,6}(?:\\s|$)')
    .replace(/HRPAT/g, ' {0,3}(?:' + HR_PAT + ')(?:\\n+|$)')
    .replace(/HTMLBLOCK/g, ' {0,3}<[^\\n>]+>\\n')
    .replace(/TABLEPAT/g, withTable ? ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n' : ''));
}
B.lheading = setextRx(true);

const HTMLBLOCK_SRC = ' {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|COMMENT[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(TAGNAME)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!((?:script|pre|style|textarea)(?![a-z0-9-])))([a-z][a-z0-9-]*)(?:ATTR)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + ')';
B.html = sy(HTMLBLOCK_SRC
  .replace(/COMMENT/g, COMMENT_PAT)
  .replace(/TAGNAME/g, TAGNAMES)
  .replace(/ATTR/g, ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?'), 'i');

const TABLE_SRC = ' *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|HRPAT|ATXPAT|QUOTEPAT|CODEPAT|FENCEPAT|LISTPAT|HTMLPAT).*(?:\\n|$))*)\\n*|$)';
B.table = sy(TABLE_SRC
  .replace(/HRPAT/g, ' {0,3}(?:' + HR_PAT + ')(?:\\n+|$)')
  .replace(/ATXPAT/g, ' {0,3}#{1,6}(?:\\s|$)')
  .replace(/QUOTEPAT/g, ' {0,3}>')
  .replace(/CODEPAT/g, '(?: {4}| {0,3}\\t)[^\\n]')
  .replace(/FENCEPAT/g, ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace(/LISTPAT/g, ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace(/HTMLPAT/g, ' {0,3}(?:</?(?:TAGNAME)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'.replace(/TAGNAME/g, TAGNAMES)));

const PARA_BODY = '([^\\n]+(?:\\n(?!HRPAT|ATXPAT|SETEXTPAT|QUOTEPAT|FENCEPAT|LISTPAT|HTMLPAT|TABLEPAT|[ \\t]+\\n)[^\\n]+)*)';
function paraRx(listInterrupt) {
  return sy(PARA_BODY
    .replace(/HRPAT/g, ' {0,3}(?:' + HR_PAT + ')(?:\\n+|$)')
    .replace(/ATXPAT/g, ' {0,3}#{1,6}(?:\\s|$)')
    .replace(/SETEXTPAT\|/g, '')
    .replace(/TABLEPAT/g, B.table.source)
    .replace(/QUOTEPAT/g, ' {0,3}>')
    .replace(/FENCEPAT/g, ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace(/LISTPAT/g, listInterrupt)
    .replace(/HTMLPAT/g, ' {0,3}(?:</?(?:TAGNAME)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'.replace(/TAGNAME/g, TAGNAMES)));
}
B.paragraph = paraRx(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]');
B.quoteParagraph = paraRx(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)');
// The quote pattern splices the paragraph alternative in, so it matches any
// text line; its lookaheads stop it before an interrupting block.
B.blockquote = sy('( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))('
  + B.quoteParagraph.source + ')|[^\\n]*)(?:\\n|$))+');

// Per-indent cached patterns used while collecting list items.
function perIndent(make) {
  const memo = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    return memo[idx] || (memo[idx] = make(idx));
  };
}
const nextMarkerRx = perIndent((n) => new RegExp('^ {0,' + n + '}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))'));
const hrHereRx = perIndent((n) => new RegExp('^ {0,' + n + '}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)'));
const fenceHereRx = perIndent((n) => new RegExp('^ {0,' + n + '}(?:```|~~~)'));
const atxHereRx = perIndent((n) => new RegExp('^ {0,' + n + '}#{1,6}(?:\\s|$)'));
const htmlHereRx = perIndent((n) => new RegExp('^ {0,' + n + '}(?:</?(?:' + TAGNAMES + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i'));
const quoteHereRx = perIndent((n) => new RegExp('^ {0,' + n + '}>'));
const itemRxFor = (bull) => new RegExp('( {0,3}' + bull + ')((?:[\\t ][^\\n]*)?(?:\\n|$))', 'y');

// One test for every block that ends a list item's line gathering.
const itemBreakRx = perIndent((n) => new RegExp('^ {0,' + n + '}(?:(?:```|~~~)|#{1,6}(?:\\s|$)'
  + '|(?:</?(?:' + TAGNAMES + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'
  + '|>|(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))'
  + '|((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$))', 'i'));

// ---------------------------------------------------------------------------
// Inline grammar (GFM, breaks off): sticky patterns run at the cursor.
// ---------------------------------------------------------------------------

const PUNCT_CLS = '[\\p{P}\\p{S}]';
const PUNCT_SPACE_CLS = '[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_CLS = '[^\\s\\p{P}\\p{S}]';

const I = {
  escape: /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y,
  code: /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y,
  br: /( {2,}|\\)\n(?!\s*$)[ \t]*/y,
  text: null,
  autolink: /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/y,
  tag: null,
  link: null,
  reflink: null,
  nolink: null,
  reflinkSearch: null,
  url: null,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/y,
  punctuation: new RegExp('^((?![*_])' + PUNCT_SPACE_CLS + ')', 'u'),
  anyPunct: new RegExp('\\\\(' + PUNCT_CLS + ')', 'gu'),
  anyPunctOutsideCode: new RegExp('(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(' + PUNCT_CLS + ')', 'gu'),
  emLDelim: null,
  emRDelimAst: null,
  emRDelimUnd: null,
  delLDelim: null,
  delRDelim: null,
};

// A plain-text run stops before anything another inline rule can open.
I.text = new RegExp(
  '(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)'
  + '|(?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@)'
  + '|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|(?<![^\\s*_~(])www\\.|$)'
  + '|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)'
  + '|[^a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@))))', 'y');
const COMMENT_INLINE_PAT = '<!--(?:-?>|[\\s\\S]*?-->)';
I.tag = new RegExp(COMMENT_INLINE_PAT
  + '|</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?)*\\s*/?>'
  + '|<\\?[\\s\\S]*?\\?>'
  + '|<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>', 'y');

// One matched pair of brackets holding no bracket of its own.
const ONE_BRACKET = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
// A link label, brackets nesting at most two levels (what the suite asks).
const INLINE_LABEL_PAT = '(?:\\[(?:' + ONE_BRACKET + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const BLOCK_LABEL_PAT = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';

I.link = new RegExp('!?\\[(' + INLINE_LABEL_PAT + ')\\]\\([ \\t\\n]*'
  + '(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\x00-\\x1f]+|(?=\\)))'
  + '(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)('
  + '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)'
  + '))?[ \\t\\n]*\\)', 'y');
I.reflink = new RegExp('!?\\[(' + INLINE_LABEL_PAT + ')\\]\\[(' + BLOCK_LABEL_PAT + ')\\]', 'y');
I.nolink = new RegExp('!?\\[(' + BLOCK_LABEL_PAT + ')\\](?:\\[\\])?', 'y');

const BOUNDED_BLOCK_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const BOUNDED_INLINE_LABEL = '(?:[^\\[\\]\\\\`]*(?:\\[(?:' + ONE_BRACKET + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
I.reflinkSearch = new RegExp(
  '!?\\[(' + BOUNDED_INLINE_LABEL + ')\\]\\[(' + BOUNDED_BLOCK_LABEL + ')\\]'
  + '|!?\\[(' + BOUNDED_BLOCK_LABEL + ')\\](?:\\[\\])?(?!\\()', 'g');

// Extended autolinks (GFM): www., scheme://, and bare email addresses.
// Group 1 is the scheme/www. opener, group 2 the '@' of a bare email.
I.url = new RegExp('(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])'
  + '|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?'
  + '|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*'
  + '|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-]))', 'y');

// Emphasis delimiters. GFM keeps ~ out of the punctuation classes so that
// strikethrough can nest inside emphasis.
const EM_L_CORE = '(?:\\*+(?:((?!\\*)(?!~)PUNCTCLS)|([^\\s*]))?)|(?:_+(?:((?!_)(?!~)PUNCTCLS)|([^\\s_]))?)';
I.emLDelim = new RegExp(EM_L_CORE.replace(/PUNCTCLS/g, '(?!~)' + PUNCT_CLS), 'yu');

const EM_R_AST_CORE = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)PUNCTCLS(\\*+)(?=[\\s]|$)'
  + '|NOTPS(\\*+)(?!\\*)(?=PSCLS|$)'
  + '|(?!\\*)PSCLS(\\*+)(?=NOTPS)'
  + '|[\\s](\\*+)(?!\\*)(?=PUNCTCLS)'
  + '|(?!\\*)PUNCTCLS(\\*+)(?!\\*)(?=PUNCTCLS)'
  + '|NOTPS(\\*+)(?=NOTPS)';
I.emRDelimAst = new RegExp(EM_R_AST_CORE
  .replace(/NOTPS/g, '(?:[^\\s' + PUNCT_CLS.slice(1, -1) + ']|~)')
  .replace(/PSCLS/g, '(?!~)' + PUNCT_SPACE_CLS)
  .replace(/PUNCTCLS/g, '(?!~)' + PUNCT_CLS), 'gu');

const EM_R_UND_CORE = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)PUNCTCLS(_+)(?=[\\s]|$)'
  + '|NOTPS(_+)(?!_)(?=PSCLS|$)'
  + '|(?!_)PSCLS(_+)(?=NOTPS)'
  + '|[\\s](_+)(?!_)(?=PUNCTCLS)'
  + '|(?!_)PUNCTCLS(_+)(?!_)(?=PUNCTCLS)';
I.emRDelimUnd = new RegExp(EM_R_UND_CORE
  .replace(/NOTPS/g, NOT_PUNCT_SPACE_CLS)
  .replace(/PSCLS/g, PUNCT_SPACE_CLS)
  .replace(/PUNCTCLS/g, PUNCT_CLS), 'gu');

I.delLDelim = new RegExp('~~?(?:((?!~)' + PUNCT_CLS + ')|[^\\s~])', 'yu');
const DEL_R_CORE = '^[^~]+(?=[^~])'
  + '|(?!~)PUNCTCLS(~~?)(?=[\\s]|$)'
  + '|NOTPS(~~?)(?!~)(?=PSCLS|$)'
  + '|(?!~)PSCLS(~~?)(?=NOTPS)'
  + '|[\\s](~~?)(?!~)(?=PUNCTCLS)'
  + '|(?!~)PUNCTCLS(~~?)(?!~)(?=PUNCTCLS)'
  + '|NOTPS(~~?)(?=NOTPS)';
I.delRDelim = new RegExp(DEL_R_CORE
  .replace(/NOTPS/g, NOT_PUNCT_SPACE_CLS)
  .replace(/PSCLS/g, PUNCT_SPACE_CLS)
  .replace(/PUNCTCLS/g, PUNCT_CLS), 'gu');

// Sequences emphasis must skip over: links, code spans and raw HTML tags.
I.skipSeq = new RegExp(
  '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)'
  + '|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)'
  + '|<(?! )[^<>]*?>', 'g');
I.anyPunctOutsideCode = new RegExp('(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(' + PUNCT_CLS + ')', 'gu');

// ---------------------------------------------------------------------------
// Block scanning. The scanner walks the source with a cursor, appending HTML
// fragments (plain strings, or inline jobs rendered once every link
// definition in the document is known) to `out`. `prev` describes the most
// recent block, for the merges marked performs.
// ---------------------------------------------------------------------------

function freshState() {
  return { defs: Object.create(null), jobs: [], inLink: false, inRaw: false, linkOut: false };
}

function queueJob(state, src) {
  const job = { src, html: null };
  state.jobs.push(job);
  return job;
}

// Run a sticky pattern at `pos` in `src`; null when it does not match there.
function matchAt(rx, src, pos) {
  rx.lastIndex = pos;
  return rx.exec(src);
}

function codeBody(text) {
  return text ? text.replace(/\n$/, '') + '\n' : '';
}

function fenceIndent(raw, text) {
  const m = /^(\s+)(?:```)/.exec(raw);
  if (!m) return text;
  const pad = m[1];
  return text.split('\n').map((line) => {
    const lm = /^\s+/.exec(line);
    if (!lm) return line;
    return line.slice(Math.min(lm[0].length, pad.length));
  }).join('\n');
}

function scanBlocks(src, pos, end, out, state, top, clipped, prevIn) {
  // Blocks parsed by this call, in order. The list scanner needs them to
  // decide looseness and to place task checkboxes.
  const seen = [];
  const gaps = [];
  let prev = prevIn || null;
  const note = (type, raw, job, start, len, text) => {
    const b = { type, raw, job, partsStart: start, partsLen: len };
    if (text !== undefined) b.text = text;
    seen.push(b);
    return b;
  };
  while (pos < end) {
    let m;

    // Blank lines / newline spacer.
    if ((m = matchAt(B.newline, src, pos))) {
      const raw = m[0];
      pos += raw.length;
      if (raw.length === 1 && prev) {
        prev.raw += '\n';
      } else {
        gaps.push(raw);
        prev = note('space', raw, null, out.length, 0);
      }
      continue;
    }

    // Indented code block. It cannot interrupt a paragraph: it is merged in.
    if ((m = matchAt(B.code, src, pos))) {
      const raw = dropTrailingBlanks(m[0]);
      const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
      pos += m[0].length;
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.job.src += '\n' + text;
      } else {
        const p0 = out.length;
        out.push('<pre><code>' + esc(codeBody(text), true) + '</code></pre>\n');
        prev = note('code', raw, null, p0, 1);
      }
      continue;
    }

    // Fenced code block.
    if ((m = matchAt(B.fences, src, pos))) {
      const raw = m[0];
      const text = fenceIndent(raw, m[3] || '');
      const lang = m[2] ? m[2].trim().replace(I.anyPunct, '$1') : m[2];
      pos += raw.length;
      const word = (lang || '').match(/^\S*/)[0];
      let html = '<pre><code';
      if (word) html += ' class="language-' + esc(word) + '"';
      html += '>' + esc(codeBody(text), true) + '</code></pre>\n';
      const p0 = out.length;
      out.push(html);
      prev = note('code', raw, null, p0, 1);
      continue;
    }

    // ATX heading.
    if ((m = matchAt(B.heading, src, pos))) {
      let text = m[2].trim();
      if (/#$/.test(text)) {
        const cut = stripTrailing(text, '#');
        if (!cut || /[ \t]$/.test(cut)) text = cut.trim();
      }
      const raw = stripTrailing(m[0], '\n');
      pos += m[0].length;
      const job = queueJob(state, text);
      const p0 = out.length;
      out.push('<h' + m[1].length + '>', job, '</h' + m[1].length + '>\n');
      prev = note('heading', raw, job, p0, 3);
      continue;
    }

    // Thematic break.
    if ((m = matchAt(B.hr, src, pos))) {
      const raw = stripTrailing(m[0], '\n');
      pos += m[0].length;
      const p0 = out.length;
      out.push('<hr>\n');
      prev = note('hr', raw, null, p0, 1);
      continue;
    }

    // Block quote.
    {
      const p0 = out.length;
      const r = scanQuote(src, pos, end, out, state);
      if (r) {
        pos = r.end;
        prev = note('blockquote', r.prev.raw, null, p0, out.length - p0, r.prev.text);
        continue;
      }
    }

    // List.
    {
      const p0 = out.length;
      const r = scanList(src, pos, end, out, state);
      if (r) {
        pos = r.end;
        prev = note('list', r.prev.raw, null, p0, out.length - p0);
        continue;
      }
    }

    // Raw HTML block.
    if ((m = matchAt(B.html, src, pos))) {
      const raw = dropTrailingBlanks(m[0]);
      pos += m[0].length;
      const p0 = out.length;
      out.push(raw);
      prev = note('html', raw, null, p0, 1);
      continue;
    }

    // Link reference definition.
    if ((m = matchAt(B.def, src, pos))) {
      const raw = stripTrailing(m[0], '\n');
      // An unbalanced destination means this is not a definition at all:
      // leave the text for the later rules instead of consuming it.
      if (/^</.test(m[2]) || closingBracket(m[2], '()') === -1) {
        pos += m[0].length;
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          // A definition cannot interrupt a paragraph: it joins its text.
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
          prev.job.src += '\n' + raw;
        } else {
          const key = labelKey(m[1]);
          if (!state.defs[key]) {
            const href = m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(I.anyPunct, '$1') : '';
            const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(I.anyPunct, '$1') : m[3];
            state.defs[key] = { href, title };
          }
          prev = note('def', raw, null, out.length, 0);
        }
        continue;
      }
    }

    // Table (GFM).
    {
      const p0 = out.length;
      const r = scanTable(src, pos, out, state);
      if (r) {
        pos = r.end;
        prev = note('table', r.prev.raw, null, p0, out.length - p0);
        continue;
      }
    }

    // Setext heading.
    if ((m = matchAt(B.lheading, src, pos))) {
      const text = m[1].trim();
      const raw = stripTrailing(m[0], '\n');
      pos += m[0].length;
      const job = queueJob(state, text);
      const depth = m[2].charAt(0) === '=' ? 1 : 2;
      const p0 = out.length;
      out.push('<h' + depth + '>', job, '</h' + depth + '>\n');
      prev = note('heading', raw, job, p0, 3);
      continue;
    }

    // Top-level paragraph (not inside a list item).
    if (top && (m = matchAt(B.paragraph, src, pos))) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      pos += m[0].length;
      if (clipped && prev && prev.type === 'paragraph') {
        // A paragraph clipped by the caller merges with the previous one.
        prev.job.src += '\n' + text;
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + m[0];
      } else {
        const job = queueJob(state, text);
        const p0 = out.length;
        out.push('<p>', job, '</p>\n');
        prev = note('paragraph', m[0], job, p0, 3);
      }
      clipped = false;
      continue;
    }

    // Plain text block (list items, and anywhere a paragraph cannot start).
    if ((m = matchAt(B.text, src, pos))) {
      const raw = m[0];
      pos += raw.length;
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + raw;
        prev.job.src += '\n' + raw;
      } else {
        const job = queueJob(state, raw);
        const p0 = out.length;
        out.push(job);
        prev = note('text', raw, job, p0, 1);
      }
      continue;
    }

    // Nothing matched: skip one character so the loop always progresses.
    pos++;
  }
  return { prev, blocks: seen, gaps };
}

// ---------------------------------------------------------------------------
// Block quote, list and table. These return {end, prev} (prev: the block's
// raw and, for quotes, its text) so the caller's continuation logic can
// re-parse them with lazy lines attached, exactly as marked does.
// ---------------------------------------------------------------------------

function lineAt(src, pos) {
  const nl = src.indexOf('\n', pos);
  return nl === -1 ? src.slice(pos) : src.slice(pos, nl);
}

const QUOTE_START = /^ {0,3}>/;
const QUOTE_STRIP = /^ {0,3}>[ \t]?/gm;
const QUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const QUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;

function scanQuote(src, pos, end, out, state) {
  const m = matchAt(B.blockquote, src, pos);
  if (!m) return null;
  let lines = stripTrailing(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const inner = [];
  let lastInner = null;

  while (lines.length > 0) {
    let inQuote = false;
    const cur = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (QUOTE_START.test(lines[i])) {
        cur.push(lines[i]);
        inQuote = true;
      } else if (!inQuote) {
        cur.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const curRaw = cur.join('\n');
    const curText = curRaw
      .replace(QUOTE_MARKER_WS, (_, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(QUOTE_SETEXT, '\n    $1')
      .replace(QUOTE_STRIP, '');
    raw = raw ? raw + '\n' + curRaw : curRaw;
    text = text ? text + '\n' + curText : curText;

    const res = scanBlocks(curText, 0, curText.length, inner, state, true, true, lastInner);
    lastInner = res.prev;
    if (lines.length === 0) break;

    const lt = res.prev;
    if (lt && (lt.type === 'code' || lt.type === 'heading' || lt.type === 'hr' || lt.type === 'html' || lt.type === 'table')) {
      break;
    } else if (lt && lt.type === 'blockquote') {
      // A lazy continuation belongs to the nested quote: re-parse it whole.
      const oldTok = lt;
      const newText = oldTok.raw + '\n' + lines.join('\n').replace(QUOTE_STRIP, '');
      const tmp = [];
      const nt = scanQuote(newText, 0, newText.length, tmp, state);
      inner.length = oldTok.partsStart;
      inner.push(...tmp);
      const leftover = newText.substring(nt.prev.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - oldTok.text.length) + nt.prev.text;
      lines = lines.slice(consumed.length);
      lastInner = { type: 'blockquote', raw: nt.prev.raw, text: nt.prev.text, partsStart: oldTok.partsStart, partsLen: tmp.length };
      if (lines.length > 0 && QUOTE_START.test(lines[0])) continue;
      break;
    } else if (lt && lt.type === 'list') {
      // A lazy continuation belongs to the nested list: re-parse it whole.
      const oldTok = lt;
      const newText = oldTok.raw + '\n' + lines.join('\n');
      const tmp = [];
      const nt = scanList(newText, 0, newText.length, tmp, state);
      inner.length = oldTok.partsStart;
      inner.push(...tmp);
      const consumedCount = nt.prev.raw.length > oldTok.raw.length
        ? newText.slice(oldTok.raw.length + 1, nt.prev.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      lastInner = { type: 'list', raw: nt.prev.raw, partsStart: oldTok.partsStart, partsLen: tmp.length };
      continue;
    }
    // Any other last block: the next group of lines is parsed on its own.
  }

  const p0 = out.length;
  out.push('<blockquote>\n', ...inner, '</blockquote>\n');
  return { end: pos + raw.length, prev: { type: 'blockquote', raw, text, partsStart: p0, partsLen: out.length - p0 } };
}

function scanList(src, pos, end, out, state) {
  const cap = matchAt(B.list, src, pos);
  if (!cap) return null;
  const listStart = pos;
  let bull = cap[1].trim();
  const ordered = bull.length > 1;
  const list = {
    ordered,
    start: ordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRx = itemRxFor(bull);
  let endsWithBlank = false;

  while (pos < end) {
    let c;
    if (!(c = matchAt(itemRx, src, pos))) break;
    if (matchAt(B.hr, src, pos)) break;

    const itemStart = pos;
    pos += c[0].length;
    const nlIdx = c[2].indexOf('\n');
    const firstLine = nlIdx === -1 ? c[2] : c[2].slice(0, nlIdx);
    const bulletIndent = c[1].length;
    let line = firstLine.replace(/^[ \t]+/, (ws) => expandTabs(ws, bulletIndent));
    let nextLine = lineAt(src, pos);
    let blankLine = !line.trim();
    let indent = 0;
    let itemContents = '';
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(/[^ ]/);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    let endEarly = false;
    if (blankLine && /^[ \t]*$/.test(nextLine)) {
      pos += nextLine.length + 1;
      endEarly = true;
    }

    if (!endEarly) {
      const nbRx = nextMarkerRx(indent);
      const hrRx = hrHereRx(indent);
      const feRx = fenceHereRx(indent);
      const heRx = atxHereRx(indent);
      const htRx = htmlHereRx(indent);
      const brRx = itemBreakRx(indent);
      const contentLines = [itemContents];
      while (pos < end) {
        const rawLine = lineAt(src, pos);
        nextLine = rawLine;
        if (brRx.test(nextLine)) break;
        const noTabs = nextLine.includes('\t')
          ? nextLine.replace(/^[ \t]+/, (ws) => expandTabs(ws))
          : nextLine;
        if (noTabs.search(/[^ ]/) >= indent || !nextLine.trim()) {
          contentLines.push(noTabs.slice(indent));
        } else {
          if (blankLine) break;
          if (line.replace(/\t/g, '    ').search(/[^ ]/) >= 4) break;
          if (feRx.test(line)) break;
          if (heRx.test(line)) break;
          if (htRx.test(line)) break;
          if (hrRx.test(line)) break;
          // A lazy continuation can look like a setext underline once the
          // list indentation is removed: keep it in the paragraph.
          const setextCont = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && matchAt(B.lheading, line + '\n' + nextLine, 0) !== null;
          const cont = setextCont ? '    ' + noTabs.replace(/^ {0,3}/, '') : nextLine;
          contentLines.push(cont);
        }
        blankLine = !nextLine.trim();
        pos += rawLine.length + 1;
        line = noTabs.slice(indent);
      }
      itemContents = contentLines.join('\n');
    }

    const raw = src.slice(itemStart, Math.min(pos, end));
    if (!list.loose) {
      if (endsWithBlank) list.loose = true;
      else if (/\n[ \t]*\n[ \t]*$/.test(raw)) endsWithBlank = true;
    }
    list.items.push({
      raw,
      task: /^\[[ xX]\][ \t]+\S/.test(itemContents),
      text: itemContents,
    });
  }

  const lastItem = list.items.at(-1);
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  const listRaw = src.slice(listStart, Math.min(pos, end)).trimEnd();

  // Scan each item's blocks; a blank-line spacer inside an item makes the
  // whole list loose.
  for (const item of list.items) {
    const itemParts = [];
    const res = scanBlocks(item.text, 0, item.text.length, itemParts, state, false, false, null);
    item.parts = itemParts;
    item.blocks = res.blocks;
    if (!list.loose) {
      list.loose = res.gaps.length > 0 && res.gaps.some((r) => /\n.*\n/.test(r));
    }
  }

  // In a loose list, bare text blocks become paragraphs.
  if (list.loose) {
    for (const item of list.items) {
      const textBlocks = item.blocks.filter((b) => b.type === 'text');
      for (let i = textBlocks.length - 1; i >= 0; i--) {
        const b = textBlocks[i];
        item.parts.splice(b.partsStart, b.partsLen, '<p>', b.job, '</p>\n');
      }
    }
  }

  // Place task checkboxes.
  for (const item of list.items) {
    const firstBlock = item.blocks[0];
    if (item.task && firstBlock && (firstBlock.type === 'text' || firstBlock.type === 'paragraph')) {
      item.text = item.text.replace(/^\[[ xX]\][ \t]+/, '');
      // The marker sits at the start of the first block's text, so that
      // block's job is the one to strip; no scan over all jobs is needed.
      firstBlock.job.src = firstBlock.job.src.replace(/^\[[ xX]\][ \t]+/, '');
      const taskRaw = /\[[ xX]\]/.exec(item.raw);
      if (taskRaw) {
        const checked = taskRaw[0] !== '[ ]';
        const box = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        if (list.loose) {
          // Inside the first paragraph, right after its opening tag.
          item.parts.splice(firstBlock.partsStart + 1, 0, box);
        } else {
          item.parts.splice(0, 0, box);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  const tag = list.ordered ? 'ol' : 'ul';
  const startAttr = (list.ordered && list.start !== 1) ? (' start="' + list.start + '"') : '';
  const p0 = out.length;
  out.push('<' + tag + startAttr + '>\n');
  for (const item of list.items) {
    out.push('<li>', ...item.parts, '</li>\n');
  }
  out.push('</' + tag + '>\n');
  return { end: listStart + listRaw.length, prev: { type: 'list', raw: listRaw, partsStart: p0, partsLen: out.length - p0 } };
}

function scanTable(src, pos, out, state) {
  const m = matchAt(B.table, src, pos);
  if (!m) return null;
  if (!/[:|]/.test(m[2])) return null;
  const headers = splitRow(m[1]);
  const aligns = m[2].replace(/^\||\| *$/g, '').split('|');
  const rows = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  if (headers.length !== aligns.length) return null;
  const alignOf = aligns.map((a) => {
    if (/^ *-+: *$/.test(a)) return 'right';
    if (/^ *:-+: *$/.test(a)) return 'center';
    if (/^ *:-+ *$/.test(a)) return 'left';
    return null;
  });
  const cellParts = (text, header, align) => {
    const job = queueJob(state, text);
    const tag = header ? 'th' : 'td';
    const open = align ? `<${tag} align="${align}">` : `<${tag}>`;
    return [open, job, `</${tag}>\n`];
  };
  const headCells = [];
  for (let i = 0; i < headers.length; i++) headCells.push(...cellParts(headers[i], true, alignOf[i]));
  const bodyParts = [];
  for (const row of rows) {
    const cells = splitRow(row, headers.length);
    bodyParts.push('<tr>\n');
    for (let i = 0; i < cells.length; i++) bodyParts.push(...cellParts(cells[i], false, alignOf[i]));
    bodyParts.push('</tr>\n');
  }
  const raw = stripTrailing(m[0], '\n');
  const p0 = out.length;
  out.push('<table>\n<thead>\n<tr>\n', ...headCells, '</tr>\n</thead>\n');
  if (bodyParts.length > 0) out.push('<tbody>', ...bodyParts, '</tbody>');
  out.push('</table>\n');
  return { end: pos + raw.length, prev: { type: 'table', raw, partsStart: p0, partsLen: out.length - p0 } };
}

// ---------------------------------------------------------------------------
// Inline rendering. One call renders one inline run (a paragraph's text, a
// heading, a table cell, a link label, ...). Definitions are complete before
// any run is rendered: block scanning finishes first. The state shared
// across the runs of one parse() call is inLink (a raw <a> left open),
// inRaw (reset before each top-level run) and linkOut.
// ---------------------------------------------------------------------------

function labelEndInsideToken(src, from, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let j = 0; j < label.length; j++) {
    if (label[j] === '\\') { j++; continue; }
    if (label[j] === '`') {
      const code = matchAt(I.code, label, j);
      if (code) { j += code[0].length - 1; continue; }
    }
    if (label[j] !== '<') continue;
    const tokenSrc = src.slice(from + labelStart + j);
    const token = matchAt(I.tag, tokenSrc, 0) || matchAt(I.autolink, tokenSrc, 0);
    if (!token) continue;
    if (token[0].length > label.length - j) return true;
    j += token[0].length - 1;
  }
  return false;
}

// Build a link or image token's HTML from its parts. `inner` is the label
// rendered already (normal mode for a link, plain-text mode for an image).
function linkHtml(cap, href, title, raw, state, plain) {
  const text = cap[1].replace(/\\([\[\]])/g, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = state.inLink;
  const outerOut = state.linkOut;
  const outerRaw = state.inRaw;
  state.inLink = true;
  state.linkOut = false;
  // An image label is plain text (its alt); a label inside plain text stays
  // plain text. Anything else renders normally.
  const inner = renderInline(text, state, plain || isImage, false);
  const innerHasLink = state.linkOut;
  state.linkOut = outerOut;
  state.inLink = outerInLink;
  if (!isImage) {
    // A link may not contain another link: bail, and the inner link is the
    // one the re-scan keeps.
    if (innerHasLink) {
      state.inRaw = outerRaw;
      return null;
    }
    state.linkOut = true;
  }
  // In plain-text mode (an image alt, a heading's text) a link or image is
  // just its label text, with no tag.
  if (plain) return { html: inner, len: raw.length };
  if (!isImage) {
    const clean = cleanUrl(href);
    if (clean === null) return { html: inner, len: raw.length };
    let html = '<a href="' + esc(clean) + '"';
    if (title) html += ' title="' + esc(title) + '"';
    html += '>' + inner + '</a>';
    return { html, len: raw.length };
  }
  const clean = cleanUrl(href);
  if (clean === null) return { html: esc(inner), len: raw.length };
  let html = '<img src="' + esc(clean) + '" alt="' + esc(inner) + '"';
  if (title) html += ' title="' + esc(title) + '"';
  html += '>';
  return { html, len: raw.length };
}

function tryInlineLink(src, i, state, plain, hasParen) {
  if (!hasParen) return null;
  const m = matchAt(I.link, src, i);
  if (!m) return null;
  const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelEndInsideToken(src, i, m[1], labelStart)) return null;
  const trimmedUrl = m[2].trim();
  let href = m[2];
  let title = '';
  let raw = m[0];
  let truncated = false;
  if (trimmedUrl.charAt(0) === '<') {
    if (trimmedUrl.charAt(trimmedUrl.length - 1) !== '>') return null;
    const r = stripTrailing(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - r.length) % 2 === 0) return null;
  } else {
    const lastParen = closingBracket(m[2], '()');
    if (lastParen === -2) return null;
    if (lastParen > -1) {
      const start = m[0].charAt(0) === '!' ? 5 : 4;
      const linkLen = start + m[1].length + lastParen;
      href = m[2].substring(0, lastParen);
      raw = m[0].substring(0, linkLen).trim();
      truncated = true;
    }
  }
  // The ')' that ends the match is the link closer only when unescaped.
  const unesc = stripTrailing(raw.slice(0, -1), '\\');
  if ((raw.length - unesc.length) % 2 === 0) return null;
  if (!truncated) title = m[3] ? m[3].slice(1, -1) : '';
  href = href.trim();
  if (href.charAt(0) === '<') href = href.slice(1, -1);
  return linkHtml(m, href ? href.replace(I.anyPunct, '$1') : href,
    title ? title.replace(I.anyPunct, '$1') : title, raw, state, plain);
}

function tryRefLink(src, i, state, plain) {
  const m = matchAt(I.reflink, src, i) || matchAt(I.nolink, src, i);
  if (!m) return null;
  const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelEndInsideToken(src, i, m[1], labelStart)) return null;
  const def = state.defs[labelKey(m[2] || m[1])];
  if (!def) return { char: m[0].charAt(0) };
  return linkHtml(m, def.href, def.title, m[0], state, plain);
}

function autolinkHtml(href, text, plain) {
  if (plain) return text;
  const clean = cleanUrl(href);
  if (clean === null) return esc(text, true);
  return '<a href="' + esc(clean, true) + '">' + esc(text, true) + '</a>';
}

function renderInline(src, state, plain, topLevel) {
  if (topLevel) state.inRaw = false;
  const out = [];
  const hasParen = src.includes(')');
  let masked = null;
  let i = 0;
  let prevChar = '';
  let keepPrev = false;
  while (i < src.length) {
    if (!keepPrev) prevChar = '';
    keepPrev = false;
    let m;

    // Backslash escape.
    if ((m = matchAt(I.escape, src, i))) {
      out.push(plain ? m[1] : esc(m[1]));
      i += m[0].length;
      continue;
    }

    // Raw HTML tag.
    if ((m = matchAt(I.tag, src, i))) {
      const tag = m[0];
      if (!state.inLink && /^<a /i.test(tag)) state.inLink = true;
      else if (state.inLink && /^<\/a>/i.test(tag)) state.inLink = false;
      if (!state.inRaw && /^<(pre|code|kbd|script)(\s|>)/i.test(tag)) state.inRaw = true;
      else if (state.inRaw && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) state.inRaw = false;
      out.push(tag);
      i += tag.length;
      continue;
    }

    // Inline link or image.
    if (hasParen) {
      const r = tryInlineLink(src, i, state, plain, hasParen);
      if (r) { out.push(r.html); i += r.len; continue; }
    }

    // Reference link.
    {
      const r = tryRefLink(src, i, state, plain);
      if (r) {
        if (r.char) { out.push(r.char); i += 1; continue; }
        out.push(r.html); i += r.len; continue;
      }
    }

    // Emphasis / strong emphasis.
    {
      if (masked === null && (src.includes('*') || src.includes('_') || src.includes('~'))) masked = maskForEmphasis(src, state);
      const r = masked !== null ? tryEmphasis(src, i, masked, prevChar, state, plain) : null;
      if (r) { out.push(r.html); i += r.len; continue; }
    }

    // Code span.
    if ((m = matchAt(I.code, src, i))) {
      let text = m[2].replace(/\n/g, ' ');
      if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
      out.push(plain ? text : '<code>' + esc(text, true) + '</code>');
      i += m[0].length;
      continue;
    }

    // Hard line break.
    if ((m = matchAt(I.br, src, i))) {
      if (!plain) out.push('<br>');
      i += m[0].length;
      continue;
    }

    // Strikethrough (GFM).
    {
      if (masked === null && (src.includes('*') || src.includes('_') || src.includes('~'))) masked = maskForEmphasis(src, state);
      const r = masked !== null ? tryStrike(src, i, masked, prevChar, state, plain) : null;
      if (r) { out.push(r.html); i += r.len; continue; }
    }

    // Autolink <scheme:...> or <email>.
    if ((m = matchAt(I.autolink, src, i))) {
      const text = m[1];
      const href = m[2] === '@' ? 'mailto:' + text : text;
      out.push(autolinkHtml(href, text, plain));
      i += m[0].length;
      continue;
    }

    // Extended autolink (GFM): www., scheme://, bare email.
    if (!state.inLink && (m = matchAt(I.url, src, i))) {
      let cap0 = m[0];
      let prev;
      do {
        prev = cap0;
        I.backpedal.lastIndex = 0;
        const b = I.backpedal.exec(cap0);
        cap0 = b ? b[0] : '';
      } while (prev !== cap0);
      const text = cap0;
      let href;
      if (m[2] === '@') href = 'mailto:' + text;
      else if (m[1] === 'www.') href = 'http://' + text;
      else href = text;
      out.push(autolinkHtml(href, text, plain));
      i += cap0.length;
      continue;
    }

    // Plain text.
    if ((m = matchAt(I.text, src, i))) {
      const raw = m[0];
      if (state.inRaw) {
        out.push(raw);
      } else if (plain) {
        out.push(decodeRefs(raw));
      } else {
        out.push(esc(decodeRefs(raw)));
      }
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      keepPrev = true;
      i += raw.length;
      continue;
    }

    // Nothing matched: emit one character as text so the scan progresses.
    const ch = src[i];
    out.push(plain ? ch : esc(ch));
    if (ch !== '_') prevChar = ch;
    keepPrev = true;
    i++;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Entry point. Each call is independent: fresh link definitions, fresh
// inline jobs, no state carried from an earlier case.
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const state = freshState();
  const out = [];
  scanBlocks(src, 0, src.length, out, state, true, false, null);
  // Render every inline job in creation order (the order the reference
  // renders them in), including jobs orphaned by a blockquote re-parse, so
  // the shared link/raw-block state evolves the same way.
  for (const job of state.jobs) {
    if (job.html === null) job.html = renderInline(job.src, state, false, true);
  }
  let html = '';
  for (const p of out) html += typeof p === 'string' ? p : p.html;
  return html;
}

// ---------------------------------------------------------------------------
// Emphasis, strong emphasis and strikethrough. Delimiters inside links,
// code spans, raw HTML and escapes are masked out first, so the closer
// search never sees them; the flanking rules (CommonMark rules 9-10) are
// applied over the whole delimiter run, as marked does.
// ---------------------------------------------------------------------------

const UNI_ALNUM = /[\p{L}\p{N}]/u;

function textHasLink(text, state) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(I.skipSeq)) {
    if (matchAt(I.link, match[0], 0) !== null && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(I.reflinkSearch)) {
    const m0 = match[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!' || !Object.hasOwn(state.defs, labelKey(m0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && textHasLink(m0.slice(1, refStart - 1), state)) continue;
    return true;
  }
  return false;
}

function maskForEmphasis(src, state) {
  let masked = src;
  if (src.includes('[')) {
    const maskOne = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(state.defs, labelKey(m0.slice(refStart + 1, -1)))) return m0;
      // A candidate holding a link never becomes one, so mask the links it
      // holds instead of flattening the whole span.
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (textHasLink(text, state)) {
          return '[' + text.replace(I.reflinkSearch, maskOne)
            + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    masked = masked.replace(I.reflinkSearch, maskOne);
  }
  // Mask escapes (a backslash is literal inside a code span, so mask the
  // backticks there instead, keeping the span skippable). Only when the run
  // can hold one: no backslash and no backtick means nothing to mask.
  if (src.includes('\\') || src.includes('`')) {
    masked = masked.replace(I.anyPunctOutsideCode, (m0, code, punct) => {
      if (punct) return '+'.repeat(m0.length);
      if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return m0;
    });
  }
  // Mask links, code spans and raw HTML tags. Only when the run can hold
  // one: a link needs '[', a code span '`', a tag '<'.
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(I.skipSeq, (m0) => '[' + 'a'.repeat(m0.length - 2) + ']');
  }
  return masked;
}

function tryEmphasis(src, i, masked, prevChar, state, plain) {
  const m = matchAt(I.emLDelim, src, i);
  if (!m) return null;
  if (!m[1] && !m[2] && !m[3] && !m[4]) return null;
  const delim = src[i];
  const midRun = prevChar === delim;
  // The run may have started before this position: flanking and rules 9-10
  // are about the whole run, so find its start in the masked source.
  let runStart = i;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const runPrev = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrev === '*' || runPrev === '_' || I.punctuation.exec(runPrev) !== null;
  if (runStart < i) prevChar = runPrev;
  const prevPunct = runStart < i ? runPrevPunct : I.punctuation.exec(prevChar) !== null;

  // An underscore cannot open between two alphanumerics.
  if (m[4] && UNI_ALNUM.test(prevChar)) return null;

  const nextChar = m[1] || m[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const openLen = [...m[0]].length - 1;
    let closeDelim, closeLen, total = openLen, midTotal = 0;
    const runLen = i - runStart + openLen;
    const openerCloses = !!runPrev.trim()
      && (!!nextChar || (delim === '*' && !runPrevPunct));
    if (delim !== '*' && delim !== '_') return null;
    const closer = delim === '*' ? I.emRDelimAst : I.emRDelimUnd;
    const win = masked.slice(i + openLen);
    closer.lastIndex = 0;
    let match;
    while ((match = closer.exec(win)) !== null) {
      closeDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!closeDelim) continue;
      closeLen = [...closeDelim].length;
      if (match[3] || match[4]) {
        total += closeLen;
        continue;
      } else if (match[5] || match[6] || openerCloses) {
        if (midRun && (match[5] || match[6])) break;
        if (runLen % 3 && !((runLen + closeLen) % 3)) {
          midTotal += closeLen;
          continue;
        }
      }
      total -= closeLen;
      if (total > 0) continue;
      closeLen = Math.min(closeLen, closeLen + total + midTotal);
      const firstLen = [...match[0]][0].length;
      const raw = src.slice(i, i + openLen + match.index + firstLen + closeLen);
      if (Math.min(openLen, closeLen) % 2) {
        const text = raw.slice(1, -1);
        return {
          html: (plain ? '' : '<em>') + renderInline(text, state, plain, false) + (plain ? '' : '</em>'),
          len: raw.length,
        };
      }
      const text = raw.slice(2, -2);
      return {
        html: (plain ? '' : '<strong>') + renderInline(text, state, plain, false) + (plain ? '' : '</strong>'),
        len: raw.length,
      };
    }
  }
  return null;
}

function tryStrike(src, i, masked, prevChar, state, plain) {
  const m = matchAt(I.delLDelim, src, i);
  if (!m) return null;
  const nextChar = m[1] || '';
  if (!nextChar || !prevChar || I.punctuation.exec(prevChar) !== null) {
    const openLen = [...m[0]].length - 1;
    let closeDelim, closeLen, total = openLen;
    const closer = I.delRDelim;
    const win = masked.slice(i + openLen);
    closer.lastIndex = 0;
    let match;
    while ((match = closer.exec(win)) !== null) {
      closeDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!closeDelim) continue;
      closeLen = [...closeDelim].length;
      if (closeLen !== openLen) continue;
      if (match[3] || match[4]) {
        total += closeLen;
        continue;
      }
      total -= closeLen;
      if (total > 0) continue;
      closeLen = Math.min(closeLen, closeLen + total);
      const firstLen = [...match[0]][0].length;
      const raw = src.slice(i, i + openLen + match.index + firstLen + closeLen);
      const text = raw.slice(openLen, -openLen);
      return {
        html: (plain ? '' : '<del>') + renderInline(text, state, plain, false) + (plain ? '' : '</del>'),
        len: raw.length,
      };
    }
  }
  return null;
}
