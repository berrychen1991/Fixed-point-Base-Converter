import React, { useMemo, useState } from 'react'

function clamp(v, lo, hi){ return Math.min(hi, Math.max(lo, v)) }

function parseInputToFloat(str, base, signed){
  if (str.trim() === '') return { ok:false, val:0, err:'請輸入數值' }
  // 支援 0b / 0x 前綴
  if (base === 'auto') {
    if (/^0b[01._]+$/i.test(str)) base = 'bin'
    else if (/^0x[0-9a-f._]+$/i.test(str)) base = 'hex'
    else base = 'dec'
  }
  try{
    let val = 0
    if (base === 'dec'){
      val = Number(str.replaceAll('_',''))
      if (!Number.isFinite(val)) throw new Error('非數字')
    } else if (base === 'bin'){
      const s = str.replace(/^0b/i,'').replaceAll('_','')
      if (!/^[01.]+$/.test(s)) throw new Error('二進位格式錯誤')
      const [I,F=''] = s.split('.')
      let iv = 0
      for (let i=0;i<I.length;i++) iv = iv*2 + (I.charCodeAt(i)-48)
      let fv = 0, w=0.5
      for (let i=0;i<F.length;i++, w/=2) fv += (F.charCodeAt(i)-48)*w
      val = iv + fv
      // 若 signed 且最高位視作符號位（僅當沒有小數點的純樣式時才合理）
      // 但因為你可以輸入小數，這裡不自動以最高位為符號；signed 交給 Q 格式處理
    } else if (base === 'hex'){
      const s = str.replace(/^0x/i,'').replaceAll('_','')
      if (!/^[0-9a-f.]+$/i.test(s)) throw new Error('十六進位格式錯誤')
      const [I,F=''] = s.split('.')
      let iv = parseInt(I || '0', 16)
      let fv = 0
      for (let i=0;i<F.length;i++){
        fv += parseInt(F[i],16) / Math.pow(16, i+1)
      }
      val = iv + fv
    }
    return { ok:true, val }
  }catch(e){
    return { ok:false, val:0, err:e.message || '解析失敗' }
  }
}

function quantizeToQ(val, m, n, signed){
  // Q 格式：總位寬 = (signed ? 1:0) + m + n
  const total = (signed?1:0) + m + n
  const scale = 2**n
  let min, max
  if (signed){
    min = -(2**(m + n)) / scale
    max = ( (2**(m + n)) - 1 ) / scale
  } else {
    min = 0
    max = ( (2**(m + n)) - 1 ) / scale
  }
  let sat = clamp(val, min, max)
  // 四捨五入到最近的 1/scale
  let qint = Math.round(sat * scale)

  // 將 qint 映射為位元樣式
  let bits = Array(total).fill(0)
  if (signed && qint < 0){
    // 二補數：先轉正數，再取補
    qint = (2**(m+n)) + qint  // 對應到 m+n 的二補數「數值部分」
    // 加上符號位 1
    const payload = qint // m+n bits
    for (let i=0;i<(m+n);i++){
      bits[total-1-i] = (payload >> i) & 1
    }
    bits[0] = 1
  } else {
    const payload = qint
    for (let i=0;i<(m+n);i++){
      bits[total-1-i] = (payload >> i) & 1
    }
    if (signed) bits[0] = 0
  }

  // 由位元樣式反求 decimal（避免顯示時的浮誤差）
  const dec = fromBitsToFloat(bits, m, n, signed)

  return { bits, dec, min, max, total, scale }
}

function fromBitsToFloat(bits, m, n, signed){
  const total = bits.length
  let sign = 0
  let payloadBits = bits.slice(signed?1:0) // m+n bits
  if (signed){
    sign = bits[0]
    if (sign === 1){
      // 取二補數值：把 payload 視為二補數
      // 二補數的「值」 = payload - 2^(m+n)
      let val = 0
      for (let i=0;i<payloadBits.length;i++){
        val = (val<<1) | payloadBits[i]
      }
      val = val - (2**(m+n))
      return val / (2**n)
    }
  }
  // 非負
  let val = 0
  for (let i=0;i<payloadBits.length;i++){
    val = (val<<1) | payloadBits[i]
  }
  return val / (2**n)
}

function bitsToBinWithPoint(bits, m, n, signed, group4){
  const mark = signed ? [0, 1+m] : [null, (m)]
  let s = ''
  bits.forEach((b, i)=>{
    if (signed && i===0) s += b // 符號位
    else s += b
    // 插入小數點
    if (i === (signed? m : (m-1)) && n>0) s += '.'
    // 每 4 位加底線（不跨越小數點）
    if (group4){
      // 計算當前位在整數/小數段中的序號
      const pos = signed ? i-1 : i
      if (pos>=0 && pos < m+n){
        const isIntPart = pos < m
        const idxInPart = isIntPart ? (pos) : (pos - m)
        const nextIsDot = (i === (signed? m : (m-1)))
        if (!nextIsDot && ((idxInPart+1)%4===0) && !(isIntPart && n>0 && i === (signed? m-1 : m-1))){
          s += '_'
        }
      }
    }
  })
  return s
}

function bitsToHex(bits){
  const pad = (4 - (bits.length % 4)) % 4
  const arr = Array(pad).fill(0).concat(bits)
  let hex = ''
  for (let i=0;i<arr.length;i+=4){
    const nibble = (arr[i]<<3) | (arr[i+1]<<2) | (arr[i+2]<<1) | arr[i+3]
    hex += nibble.toString(16).toUpperCase()
  }
  // 每 4 位元一組的 16 進位（不放小數點，因為本質是定點）
  return hex.replace(/(.{4})/g,'$1 ').trim()
}

export default function App(){
  // 狀態
  const [raw, setRaw]                   = useState('0.3')
  const [base, setBase]                 = useState('auto') // dec/bin/hex/auto
  const [signed, setSigned]             = useState(true)
  const [m, setM]                       = useState(3)
  const [n, setN]                       = useState(5)
  const [precision, setPrecision]       = useState(6)
  const [group4, setGroup4]             = useState(true)

  // 解析輸入
  const parsed = useMemo(()=>parseInputToFloat(raw, base, signed), [raw, base, signed])

  // 量化到 Q
  const qres = useMemo(()=>{
    if (!parsed.ok) return null
    return quantizeToQ(parsed.val, Number(m)||0, Number(n)||0, signed)
  }, [parsed, m, n, signed])

  // 位元畫布點擊：切換位元
  function toggleBitAt(i){
    if (!qres) return
    const bits = qres.bits.slice()
    bits[i] = bits[i]^1
    const next = fromBitsToFloat(bits, Number(m)||0, Number(n)||0, signed)
    setRaw(String(next))
  }

  const errText = parsed.ok ? '' : parsed.err

  let out = {
    binary: '-', decimal:'-', hex:'-', twos:'-'
  }
  if (qres){
    const {bits, dec, total} = qres
    out.decimal = dec.toFixed(precision)
    out.binary  = bitsToBinWithPoint(bits, Number(m)||0, Number(n)||0, signed, group4)
    out.hex     = bitsToHex(bits)
    // 二補數樣式（即目前位元樣式）：對 signed 才有語義
    out.twos    = signed ? bits.join('') : '（Unsigned 模式）'
  }

  // 位元標籤顏色資訊
  function bitRole(i){
    // i=0 若 signed => 符號位
    if (signed && i===0) return 'sign'
    const pos = signed? i-1 : i
    if (pos < (Number(m)||0)) return 'int'
    return 'frac'
  }

  return (
    <div className="app">
      <h1>二進位計算機（Q 格式 + 位元畫布）</h1>
      <div className="desc">輸入數值 → 指定位寬（整數 m、小數 n、signed/unsigned）→ 立即看到 Binary / Decimal / Hex / 二補數位元樣式。你也可以直接點擊位元方塊來修改！</div>

      <div className="panel grid grid-3">
        <div>
          <div className="label">輸入數值</div>
          <input value={raw} onChange={e=>setRaw(e.target.value)} placeholder="例如：0.3 或 0b1.01 / 0xF.A" />
          <div className={errText ? 'err' : 'small'}>{errText || '小技巧：base 選「自動」時會辨識 0b / 0x 前綴。'}</div>
        </div>
        <div>
          <div className="label">輸入進位</div>
          <select value={base} onChange={e=>setBase(e.target.value)}>
            <option value="auto">自動（0b/0x 前綴）</option>
            <option value="dec">十進位</option>
            <option value="bin">二進位</option>
            <option value="hex">十六進位</option>
          </select>
        </div>
        <div>
          <div className="label">Signed / Unsigned</div>
          <select value={String(signed)} onChange={e=>setSigned(e.target.value==='true')}>
            <option value="true">Signed（含符號位）</option>
            <option value="false">Unsigned（無符號）</option>
          </select>
        </div>

        <div>
          <div className="label">整數位 m</div>
          <input type="number" min="0" max="30" value={m} onChange={e=>setM(+e.target.value||0)} />
        </div>
        <div>
          <div className="label">小數位 n</div>
          <input type="number" min="0" max="30" value={n} onChange={e=>setN(+e.target.value||0)} />
        </div>
        <div>
          <div className="label">顯示小數精度</div>
          <input type="number" min="0" max="18" value={precision} onChange={e=>setPrecision(+e.target.value||0)} />
        </div>

        <div>
          <div className="label">每 4 位分組</div>
          <select value={String(group4)} onChange={e=>setGroup4(e.target.value==='true')}>
            <option value="true">開啟</option>
            <option value="false">關閉</option>
          </select>
          <div className="hint" style={{marginTop:6}}>分組只影響顯示（binary 文字與位元方塊群組邊線）。</div>
        </div>
        <div className="legend">
          <span className="tag"><span className="dot signDot"></span>符號位</span>
          <span className="tag"><span className="dot intDot"></span>整數位</span>
          <span className="tag"><span className="dot fracDot"></span>小數位</span>
        </div>
      </div>

      <div className="panel">
        <div className="label">位元畫布（可左右捲動，點擊切換 0/1）</div>
        {qres && (
          <div className="canvasWrap">
            <div className="canvasBar">
              {qres.bits.map((b, i)=>{
                const role = bitRole(i)
                const content = (
                  <div className="bit" key={i} data-v={b} onClick={()=>toggleBitAt(i)}
                    style={{
                      outline: (role==='sign'?'2px solid var(--sign)': role==='int'?'2px solid var(--int)':'2px solid var(--frac)')
                    }}
                    title={`位元 ${i}（${role==='sign'?'符號位': role==='int'?'整數位':'小數位'}）`}
                  >
                    <div className="val">{b}</div>
                    <div className="idx">{i}</div>
                  </div>
                )
                // 分組：每 4 位插入一個「組界線」
                if (!qres) return content
                if (!group4) return content
                const signedOffset = (signed?1:0)
                const pos = i - (signed?1:0)
                const isBoundary = pos>=0 && ((pos+1)<= (Number(m)+Number(n))) && ((pos+1)%4===0)
                if (isBoundary && !(signed && i===0)){
                  return <div key={`g${i}`} style={{display:'flex', alignItems:'center', gap:'8px'}}>
                    {content}
                    <div className="groupMark" />
                  </div>
                }
                return content
              })}
            </div>
          </div>
        )}
        {!qres && <div className="hint">請先輸入有效的數值與位寬參數。</div>}
      </div>

      <div className="panel grid grid-2">
        <div>
          <div className="label">Binary（含小數點顯示）</div>
          <div className="out">{out.binary}</div>
        </div>
        <div>
          <div className="label">Decimal（量化後值）</div>
          <div className="out">{out.decimal}</div>
        </div>
        <div>
          <div className="label">Hex（位元圖樣，以 4 位元一組）</div>
          <div className="out">{out.hex}</div>
          <div className="small">說明：這裡是 <b>定點位元圖樣</b> 的 16 進位表示，非「小數點十六進制」。</div>
        </div>
        <div>
          <div className="label">二補數位元樣式</div>
          <div className="out">{out.twos}</div>
          <div className="small">Unsigned 模式下僅顯示位元樣式；Signed 模式即為當前二補數表示。</div>
        </div>
      </div>

      {qres && (
        <div className="panel">
          <div className="label">範圍與位寬</div>
          <div className="small">
            總位寬：{qres.total} 位（{signed?'含符號位 1 + ':''}整數 {m} + 小數 {n}）。<br/>
            允許範圍：[{qres.min.toFixed(6)}, {qres.max.toFixed(6)}]，解析度：1/{qres.scale}。
          </div>
          <div className="sep"></div>
          <div className="ok">狀態：{parsed.ok ? '🟢 正常' : '🔴 有誤'}</div>
        </div>
      )}
    </div>
  )
}
