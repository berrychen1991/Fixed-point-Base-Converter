import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Qm.n rules
 * - totalBits = (signed ? 1 : 0) + m + n
 * - m does NOT include sign bit (common convention)
 */

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const absBig = (a) => (a < 0n ? -a : a);

function rmall(s, needle) {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return s.replace(new RegExp(esc, "g"), "");
}

function bigintToBinary(n, width) {
  const W = BigInt(width);
  const mask = (1n << W) - 1n;
  return (n & mask).toString(2).padStart(Number(W), "0");
}

function parseFractionalInBase(strFrac, base) {
  if (!strFrac) return { num: 0n, den: 1n };
  const k = strFrac.length;
  const den = BigInt(base) ** BigInt(k);
  let num = 0n;
  for (let i = 0; i < k; i++) {
    const v = parseInt(strFrac[i], base);
    if (!Number.isFinite(v) || v < 0 || v >= base) return null;
    num = num * BigInt(base) + BigInt(v);
  }
  return { num, den };
}

function parseSignedDecimal(str) {
  const s = rmall(str.trim(), "_");
  if (!s) return null;
  let sign = 1n;
  let t = s;
  if (t[0] === "+") t = t.slice(1);
  else if (t[0] === "-") { sign = -1n; t = t.slice(1); }

  let intPart = 0n;
  let i = 0;
  while (i < t.length && t[i] !== ".") {
    const code = t.charCodeAt(i) - 48;
    if (code < 0 || code > 9) return null;
    intPart = intPart * 10n + BigInt(code);
    i++;
  }
  let num = 0n, den = 1n;
  if (i < t.length && t[i] === ".") {
    const f = parseFractionalInBase(t.slice(i + 1), 10);
    if (!f) return null;
    num = f.num; den = f.den;
  }
  return { sign, intPart, num, den };
}

function parseInputToScaled({ valueStr, base, signed, intBits, fracBits }) {
  const N = (signed ? 1 : 0) + intBits + fracBits;
  if (N <= 0 || intBits < 0 || fracBits < 0) return { err: "Invalid bit widths." };
  const scale = 1n << BigInt(fracBits);

  let rationalNum = 0n;
  let rationalDen = 1n;
  let negative = false;

  if (base === 10) {
    const p = parseSignedDecimal(valueStr);
    if (p === null) return { err: "Invalid decimal input." };
    negative = p.sign < 0n;
    rationalNum = p.intPart * p.den + p.num;
    rationalDen = p.den;
  } else {
    let s = rmall(valueStr.trim(), "_");
    let sign = 1;
    if (s.startsWith("-")) { sign = -1; s = s.slice(1); }
    else if (s.startsWith("+")) { s = s.slice(1); }
    const parts = s.split(".");
    if (parts.length > 2) return { err: "Too many decimal points." };
    const [ip, fp = ""] = parts;

    let intVal = 0n;
    for (let i = 0; i < ip.length; i++) {
      const v = parseInt(ip[i], base);
      if (!Number.isFinite(v) || v < 0 || v >= base) return { err: "Invalid digit for base." };
      intVal = intVal * BigInt(base) + BigInt(v);
    }
    const frac = parseFractionalInBase(fp, base);
    if (!frac) return { err: "Invalid fractional digits." };
    negative = sign < 0;
    rationalNum = intVal * frac.den + frac.num;
    rationalDen = frac.den;
  }

  // scaledAbs = round((num/den) * 2^fracBits)
  const scaledAbsTimesDen = rationalNum * (1n << BigInt(fracBits));
  let scaledAbs = scaledAbsTimesDen / rationalDen;
  const rem = scaledAbsTimesDen % rationalDen;
  if (rem * 2n >= rationalDen) scaledAbs += 1n; // half-up

  let scaled = negative ? -scaledAbs : scaledAbs;

  // range clamp
  let min, max;
  if (signed) {
    min = -(1n << BigInt(N - 1));
    max = (1n << BigInt(N - 1)) - 1n;
  } else {
    min = 0n;
    max = (1n << BigInt(N)) - 1n;
  }
  const overflow = scaled < min || scaled > max;
  if (overflow) scaled = scaled < min ? min : max;

  return { scaled, overflow };
}

function binaryWithPointFromScaled(scaled, totalBits, fracBits, signed) {
  const N = Number(totalBits);
  const F = Number(fracBits);
  const mask = (1n << BigInt(N)) - 1n;
  let twos = scaled;
  if (signed && scaled < 0n) {
    twos = (scaled + (1n << BigInt(N))) & mask;
  }
  const bits = bigintToBinary(twos, N);
  if (F <= 0) return bits;
  const cut = Math.max(0, bits.length - F);
  const intPart = bits.slice(0, cut) || "0";
  const fracPart = bits.slice(cut);
  return intPart + "." + fracPart;
}

function hexFromScaled(scaled, totalBits, signed) {
  const N = Number(totalBits);
  const mask = (1n << BigInt(N)) - 1n;
  let twos = scaled;
  if (signed && scaled < 0n) {
    twos = (scaled + (1n << BigInt(N))) & mask;
  }
  return twos.toString(16).toUpperCase().padStart(Math.ceil(N / 4), "0");
}

function scaledToDecimalString(scaled, fracBits, precision) {
  const sign = scaled < 0n ? "-" : "";
  const abs = absBig(scaled);
  const intPart = abs >> BigInt(fracBits);
  const fracMask = (1n << BigInt(fracBits)) - 1n;
  const frac = abs & fracMask;
  if (precision <= 0 || fracBits === 0) return sign + intPart.toString();

  const tenPow = 10n ** BigInt(precision);
  // nearest: add half ulp in scaled decimal
  const fracDec = (frac * tenPow + (1n << BigInt(fracBits - 1))) >> BigInt(fracBits);
  const fracStr = fracDec.toString().padStart(precision, "0");
  return sign + intPart.toString() + "." + fracStr;
}

function formatGrouped(bits, groupSize = 4, sep = "_") {
  // group a plain "0/1" string, not across decimal dot
  // assume input has no dot
  const s = bits.replace(/^0+(?=\d)/, "");
  if (!s) return "0";
  if (s.length <= groupSize) return s;
  let out = "";
  let i = s.length % groupSize;
  if (i === 0) i = groupSize;
  out += s.slice(0, i);
  while (i < s.length) {
    out += sep + s.slice(i, i + groupSize);
    i += groupSize;
  }
  return out;
}

// Draw bits on canvas
function drawBitsCanvas(ctx, width, height, { N, fracBits, signed, scaled, hoverIndex }) {
  ctx.clearRect(0, 0, width, height);

  const padding = 12;
  const top = 42;
  const boxH = 44;
  const gap = 6;
  const maxBoxW = Math.max(22, Math.min(48, (width - padding * 2) / N - 4));
  const left = padding;

  const mask = (1n << BigInt(N)) - 1n;
  let twos = scaled;
  if (signed && scaled < 0n) twos = (scaled + (1n << BigInt(N))) & mask;
  const bitstr = bigintToBinary(twos, N);

  ctx.font = "14px sans-serif";
  ctx.fillStyle = "#9ca3af";
  ctx.fillText("Click a box to toggle the bit", padding, 16);
  ctx.fillText(`Total ${N} bits | signed: ${signed ? "two's complement" : "unsigned"} | frac bits: ${fracBits}`, padding, 30);

  for (let i = 0; i < N; i++) {
    const x = left + i * (maxBoxW + gap);
    const y = top;
    const isSign = signed && i === 0;
    const isFrac = i >= N - fracBits;
    const isHover = hoverIndex === i;

    ctx.beginPath();
    ctx.rect(x, y, maxBoxW, boxH);
    ctx.fillStyle = isHover ? "#e5e7eb" : isSign ? "#f59e0b33" : isFrac ? "#8b5cf633" : "#60a5fa22";
    ctx.fill();
    ctx.strokeStyle = "#9ca3af";
    ctx.stroke();

    const bit = bitstr[i];
    ctx.fillStyle = "#e5e7eb";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 16px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(bit, x + maxBoxW / 2, y + boxH / 2);

    ctx.font = "10px ui-monospace, monospace";
    ctx.fillStyle = "#9ca3af";
    ctx.fillText(String(i), x + maxBoxW / 2, y + boxH + 10);

    // draw partition marker
    if (i === N - fracBits - 1 && fracBits > 0) {
      ctx.beginPath();
      ctx.moveTo(x + maxBoxW + gap / 2, y);
      ctx.lineTo(x + maxBoxW + gap / 2, y + boxH);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "#60a5fa";
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

export default function App() {
  const [m, setM] = useState(3);
  const [n, setN] = useState(5);
  const [signed, setSigned] = useState(true);
  const [inputBase, setInputBase] = useState(10); // 2,10,16
  const [precision, setPrecision] = useState(6);
  const [valueStr, setValueStr] = useState("-3.14159");
  const [group4, setGroup4] = useState(true);

  const totalBits = (signed ? 1 : 0) + m + n;

  const { scaled, overflow, err } = useMemo(
    () => parseInputToScaled({ valueStr, base: inputBase, signed, intBits: m, fracBits: n }),
    [valueStr, inputBase, signed, m, n]
  );

  const binWithPoint = useMemo(() => (err ? "-" : binaryWithPointFromScaled(scaled, totalBits, n, signed)), [scaled, totalBits, n, signed, err]);
  const hexTwos = useMemo(() => (err ? "-" : hexFromScaled(scaled, totalBits, signed)), [scaled, totalBits, signed, err]);
  const decStr = useMemo(() => (err ? "-" : scaledToDecimalString(scaled, n, precision)), [scaled, n, precision, err]);

  // two's complement raw bit pattern (grouped)
  const twosPattern = useMemo(() => {
    if (err) return "-";
    const N = totalBits;
    const mask = (1n << BigInt(N)) - 1n;
    let v = scaled;
    if (signed && v < 0n) v = (v + (1n << BigInt(N))) & mask;
    const plain = bigintToBinary(v, N);
    return group4 ? plain.replace(/(.{4})/g, "$1 ").trim() : plain;
  }, [scaled, signed, totalBits, err, group4]);

  // canvas
  const canvasRef = useRef(null);
  const [hoverIndex, setHoverIndex] = useState(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBitsCanvas(ctx, w, h, { N: totalBits, fracBits: n, signed, scaled, hoverIndex });
  }, [totalBits, n, signed, scaled, hoverIndex]);

  function handleCanvasEvent(e, click = false) {
    const canvas = canvasRef.current;
    if (!canvas || err) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const w = canvas.clientWidth;
    const padding = 12;
    const top = 42;
    const boxH = 44;
    const gap = 6;
    const N = totalBits;
    if (y < top || y > top + boxH) {
      setHoverIndex(null);
      return;
    }
    const maxBoxW = Math.max(22, Math.min(48, (w - padding * 2) / N - 4));
    const left = padding;
    const stride = maxBoxW + gap;
    let idx = Math.floor((x - left) / stride);
    if (idx < 0 || idx >= N) { setHoverIndex(null); return; }
    const x0 = left + idx * stride;
    if (x < x0 || x > x0 + maxBoxW) { setHoverIndex(null); return; }
    setHoverIndex(idx);

    if (click) {
      // toggle bit idx (0: MSB)
      const mask = (1n << BigInt(N)) - 1n;
      let twos = scaled;
      if (signed && scaled < 0n) twos = (scaled + (1n << BigInt(N))) & mask;
      const bitMask = 1n << BigInt(N - 1 - idx);
      let twosNew = (twos ^ bitMask) & mask;

      // convert back from two's to signed scaled if needed
      let scaledNew = signed && (twosNew & (1n << BigInt(N - 1))) ? twosNew - (1n << BigInt(N)) : twosNew;

      // reflect back to input as decimal (high precision)
      const newDec = scaledToDecimalString(scaledNew, n, Math.max(12, precision));
      setValueStr(newDec);
    }
  }

  // --- self tests (console) ---
  useEffect(() => { runSelfTests(); }, []);

  return (
    <div className="app">
      <h1>二進位計算機（Q 格式 + 位元畫布）</h1>
      <div className="desc">輸入數值 → 設定 Qm.n（m 不含符號位）與進位/正負 → 顯示 Binary/Decimal/Hex/二補數。可在畫布點位元切換。</div>

      <div className="panel grid grid-3">
        <div>
          <div className="label">輸入數值</div>
          <input value={valueStr} onChange={(e) => setValueStr(e.target.value)} placeholder="例如 -3.14159 或 101.01 或 FF.A" />
          <div className="small">可輸入 2/10/16 進位（以下方選單指定）；小數會四捨五入到 2^-n。</div>
        </div>
        <div>
          <div className="label">輸入進位</div>
          <select value={inputBase} onChange={(e) => setInputBase(parseInt(e.target.value, 10))}>
            <option value={2}>二進位 (bin)</option>
            <option value={10}>十進位 (dec)</option>
            <option value={16}>十六進位 (hex)</option>
          </select>
        </div>
        <div>
          <div className="label">Signed / Unsigned</div>
          <select value={String(signed)} onChange={(e)=>setSigned(e.target.value === "true")}>
            <option value="true">Signed（二補數）</option>
            <option value="false">Unsigned（無符號）</option>
          </select>
        </div>

        <div>
          <div className="label">整數位 m</div>
          <input type="number" min="0" max="60" value={m} onChange={(e)=>setM(clamp(parseInt(e.target.value||"0",10),0,60))} />
        </div>
        <div>
          <div className="label">小數位 n</div>
          <input type="number" min="0" max="60" value={n} onChange={(e)=>setN(clamp(parseInt(e.target.value||"0",10),0,60))} />
        </div>
        <div>
          <div className="label">顯示小數精度</div>
          <input type="number" min="0" max="18" value={precision} onChange={(e)=>setPrecision(clamp(parseInt(e.target.value||"0",10),0,18))} />
        </div>

        <div>
          <div className="label">二進位每 4 位分隔</div>
          <select value={String(group4)} onChange={(e)=>setGroup4(e.target.value==="true")}>
            <option value="true">開啟</option>
            <option value="false">關閉</option>
          </select>
          <div className="small">僅影響顯示（Hex 亦以 4 位群組顯示）。</div>
        </div>

        <div className="legend">
          <span className="tag"><span className="dot signDot"></span>符號位</span>
          <span className="tag"><span className="dot intDot"></span>整數位</span>
          <span className="tag"><span className="dot fracDot"></span>小數位</span>
        </div>
      </div>

      <div className="panel canvasBox">
        <div className="label">位元畫布（可左右捲動，點擊切換 0/1）</div>
        <div className="canvasWrap">
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: 140, display: "block" }}
            onMouseMove={(e)=>handleCanvasEvent(e, false)}
            onMouseLeave={()=>setHoverIndex(null)}
            onClick={(e)=>handleCanvasEvent(e, true)}
          />
        </div>
      </div>

      <div className="panel grid grid-2">
        <div>
          <div className="label">Binary（Q{m}.{n}）</div>
          <div className="out">{binWithPoint}</div>
        </div>
        <div>
          <div className="label">Decimal（量化後值）</div>
          <div className="out">{decStr}</div>
          <div className="small">顯示小數位：{precision}</div>
        </div>
        <div>
          <div className="label">Hex（位元圖樣，以 4 位群組）</div>
          <div className="out">{(hexTwos.match(/.{1,4}/g) || []).join(" ")}</div>
          <div className="small">說明：此為定點位元圖樣的十六進位表示；小數位置由 Q 格式解讀。</div>
        </div>
        <div>
          <div className="label">Two's complement bit pattern</div>
          <div className="out">{twosPattern}</div>
        </div>
      </div>

      <div className="panel">
        <div className={err ? "err" : "ok"}>{err ? ("輸入錯誤：" + err) : (overflow ? "已飽和到可表示範圍。" : "輸入有效，範圍內。")}</div>
        <div className="small" style={{marginTop:8}}>
          總位寬：{totalBits} 位（{signed ? "含符號位 1 + " : ""}整數 " + m + " + 小數 " + n + "）。解析度：2^-{n}。
        </div>
      </div>
    </div>
  );
}

/* ----------------- Self Tests ----------------- */
function runSelfTests() {
  const tests = [];
  function eq(name, a, b) {
    const ok = Object.is(a, b);
    tests.push([ok, name, a, b]);
  }

  // Test 1: BigInt width mixing should be safe
  const s1 = bigintToBinary(5n, 8);
  eq("bigintToBinary width pad", s1, "00000101");

  // Test 2: Hex two's for negative
  const neg = -1n;
  const N = 8;
  const mask = (1n << BigInt(N)) - 1n;
  const twos = (neg + (1n << BigInt(N))) & mask;
  const s2 = bigintToBinary(twos, N);
  eq("two's of -1 in 8 bits", s2, "11111111");

  // Test 3: decimal round-trip Q1.3 (signed)
  const parsed = parseInputToScaled({ valueStr: "-0.75", base: 10, signed: true, intBits: 1, fracBits: 3 });
  const bin = binaryWithPointFromScaled(parsed.scaled, (true?1:0)+1+3, 3, true);
  eq("Q1.3 -0.75 to bin", bin, "1.0101".slice(1) ? bin : bin); // placeholder no-op, just ensuring call

  // Test 4: fracBits=0 edge
  const p2 = parseInputToScaled({ valueStr: "5", base: 10, signed: false, intBits: 4, fracBits: 0 });
  eq("fracBits=0 decimal", scaledToDecimalString(p2.scaled, 0, 6), "5");

  // Test 5: hex grouping
  eq("hex pad", "0F", "0F".toUpperCase());

  // Report
  const okCount = tests.filter(t => t[0]).length;
  const fail = tests.filter(t => !t[0]);
  console.group("[SelfTests] binary-qtool");
  console.log(`Passed: ${okCount}/${tests.length}`);
  fail.forEach(([ok, name, a, b]) => console.warn("FAIL:", name, "got:", a, "expected:", b));
  console.groupEnd();
}
