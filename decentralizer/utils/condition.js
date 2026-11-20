const OPERATORS = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "<", ">", "!", "(", ")"];

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\" && j + 1 < src.length) j++;
        value += src[j++];
      }
      if (j >= src.length) throw new Error("Unterminated string");
      tokens.push({ type: "value", value });
      i = j + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num && (tokens.length === 0 || tokens[tokens.length - 1].type === "op")) {
      tokens.push({ type: "value", value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const ident = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*/.exec(src.slice(i));
    if (ident) {
      const word = ident[0];
      if (word === "true" || word === "false") tokens.push({ type: "value", value: word === "true" });
      else if (word === "null") tokens.push({ type: "value", value: null });
      else tokens.push({ type: "ident", value: word });
      i += word.length;
      continue;
    }
    const op = OPERATORS.find(o => src.startsWith(o, i));
    if (!op) throw new Error(`Unexpected character "${ch}"`);
    tokens.push({ type: "op", value: op });
    i += op.length;
  }
  return tokens;
}

function lookup(ctx, path) {
  return path.split(".").reduce((acc, key) => {
    if (acc == null || !Object.prototype.hasOwnProperty.call(Object(acc), key)) return undefined;
    return acc[key];
  }, ctx);
}

export function evaluateCondition(expression, ctx = {}) {
  if (!expression || !String(expression).trim()) return true;
  const tokens = tokenize(String(expression));
  let pos = 0;
  const peek = () => tokens[pos];
  const take = v => {
    const t = tokens[pos];
    if (v !== undefined && (!t || t.value !== v)) throw new Error(`Expected "${v}"`);
    pos++;
    return t;
  };

  const primary = () => {
    const t = take();
    if (!t) throw new Error("Unexpected end of condition");
    if (t.type === "value") return t.value;
    if (t.type === "ident") return lookup(ctx, t.value);
    if (t.value === "(") {
      const v = or();
      take(")");
      return v;
    }
    if (t.value === "!") return !primary();
    throw new Error(`Unexpected "${t.value}"`);
  };

  const comparison = () => {
    let left = primary();
    while (peek() && ["===", "!==", "==", "!=", "<", "<=", ">", ">="].includes(peek().value)) {
      const op = take().value;
      const right = primary();
      const l = typeof left === "string" ? left.trim().toLowerCase() : left;
      const r = typeof right === "string" ? right.trim().toLowerCase() : right;
      switch (op) {
        case "==": case "===": left = l === r; break;
        case "!=": case "!==": left = l !== r; break;
        case "<": left = l < r; break;
        case "<=": left = l <= r; break;
        case ">": left = l > r; break;
        case ">=": left = l >= r; break;
      }
    }
    return left;
  };

  const and = () => {
    let v = comparison();
    while (peek() && peek().value === "&&") { take(); const r = comparison(); v = Boolean(v) && Boolean(r); }
    return v;
  };

  const or = () => {
    let v = and();
    while (peek() && peek().value === "||") { take(); const r = and(); v = Boolean(v) || Boolean(r); }
    return v;
  };

  const result = or();
  if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos].value}"`);
  return Boolean(result);
}
