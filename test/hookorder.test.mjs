// Guards the bug class that took the Registry down: a React hook placed AFTER a
// conditional `return`. Signed out, `AgentCandidates` returns null early and the
// later hooks never run; signed in WITH candidates they do — the hook count
// changes between renders and React throws, killing the page. The smoke test
// can't see it (it runs signed out), so it is pinned here statically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HOOK = /(^|[^\w.])(useState|useEffect|useMemo|useCallback|useRef|useReducer|useLayoutEffect|useSession|useParams|useNavigate|useSearchParams|useLocation)\s*\(/;
// A bare `return ...;` at 2-space indent inside a component = an early return.
const EARLY_RETURN = /^ {2}(if\s*\(.*\)\s*return\b|return\s+null\s*;)/;

function componentsIn(dir) {
  const out = [];
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) out.push(...componentsIn(p));
    else if (f.name.endsWith(".jsx")) out.push(p);
  }
  return out;
}

test("no React hook is called after an early return inside a component", () => {
  const offenders = [];
  for (const file of [...componentsIn("src/pages"), ...componentsIn("src/components")]) {
    const lines = readFileSync(file, "utf8").split("\n");
    let sawEarlyReturn = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // A new top-level function/component resets the scope we're tracking.
      if (/^(export\s+)?(default\s+)?function\s+\w+|^const\s+\w+\s*=\s*(\([^)]*\)|\w+)\s*=>/.test(line)) sawEarlyReturn = 0;
      if (EARLY_RETURN.test(line)) { sawEarlyReturn = i + 1; continue; }
      if (sawEarlyReturn && HOOK.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*")) {
        offenders.push(`${file}:${i + 1} — hook after early return on line ${sawEarlyReturn}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Hooks must run unconditionally:\n  ${offenders.join("\n  ")}`);
});
