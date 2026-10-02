#!/usr/bin/env node
/*
 * Yahoo Finance — Ibovespa (^BVSP) e cripto (BITH11.SA) do mês fechado.
 * Público, sem cadastro e sem chave.
 *
 * Mesma regra de ouro: número que não veio da fonte vira null.
 *
 * Uso:  node buscar-mercado.js            (mês fechado anterior)
 *       node buscar-mercado.js 2026-08    (mês específico)
 */
const fs  = require("fs");
const ARQ = "benchmarks.json";

const ATIVOS = [
  { k:"rv",  simbolo:"^BVSP",     nome:"Ibovespa" },
  { k:"cri", simbolo:"BITH11.SA", nome:"BITH11"   }
];

/* faixas de sanidade: fora delas o valor é descartado, não gravado */
const FAIXA = { rv:[-40,40], cri:[-70,70] };

function sane(k, v){
  const f = FAIXA[k];
  if(!isFinite(v)) return null;
  if(f && (v < f[0] || v > f[1])){
    console.warn("  ! " + k + " = " + v + " fora da faixa " + f.join(" a ") + " — gravando null");
    return null;
  }
  return Math.round(v*100)/100;
}

/* fechamentos mensais: period1/period2 em segundos, intervalo 1 mês */
async function mensal(simbolo, de, ate){
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/"
            + encodeURIComponent(simbolo)
            + "?period1=" + Math.floor(de/1000) + "&period2=" + Math.floor(ate/1000)
            + "&interval=1mo";
  const r = await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0", "Accept":"application/json" } });
  if(!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if(!res) throw new Error("resposta sem série");
  const ts = res.timestamp || [];
  const fe = (res.indicators && res.indicators.adjclose && res.indicators.adjclose[0]
              && res.indicators.adjclose[0].adjclose)
          || (res.indicators && res.indicators.quote && res.indicators.quote[0]
              && res.indicators.quote[0].close) || [];
  const pontos = [];
  for(let i=0; i<ts.length; i++){
    const d = new Date(ts[i]*1000);
    if(typeof fe[i] === "number" && isFinite(fe[i]))
      pontos.push({ ano:d.getUTCFullYear(), mes:d.getUTCMonth()+1, v:fe[i] });
  }
  return pontos;
}

async function main(){
  const arg = process.argv[2];
  let ano, mes;
  if(arg && /^\d{4}-\d{2}$/.test(arg)){ ano = +arg.slice(0,4); mes = +arg.slice(5,7); }
  else { const d = new Date(); d.setUTCDate(0); ano = d.getUTCFullYear(); mes = d.getUTCMonth()+1; }
  const ant = mes === 1 ? { a:ano-1, m:12 } : { a:ano, m:mes-1 };
  const id  = ano + "-" + String(mes).padStart(2,"0");

  console.log("Mercado · " + String(mes).padStart(2,"0") + "/" + ano);

  /* janela folgada: 5 meses antes até o fim do mês pedido */
  const de  = Date.UTC(ant.a, ant.m - 5, 1);
  const ate = Date.UTC(ano, mes, 5);

  const out = {};
  for(const a of ATIVOS){
    try {
      const pts = await mensal(a.simbolo, de, ate);
      const fim = pts.find(p => p.ano === ano   && p.mes === mes);
      const ini = pts.find(p => p.ano === ant.a && p.mes === ant.m);
      if(!fim || !ini) throw new Error("faltou fechamento de um dos dois meses");
      out[a.k] = sane(a.k, (fim.v/ini.v - 1) * 100);
      console.log("  " + a.nome + ": " + ini.v.toFixed(2) + " → " + fim.v.toFixed(2)
                  + " = " + out[a.k] + "%");
    } catch(e){
      out[a.k] = null;
      console.warn("  ! " + a.nome + " NÃO OBTIDO — " + e.message);
    }
  }

  /* --- grava no mês que já existe, sem tocar no que não é nosso --- */
  if(!fs.existsSync(ARQ)){ console.error("benchmarks.json não encontrado"); process.exit(1); }
  const base = JSON.parse(fs.readFileSync(ARQ, "utf8"));
  const alvo = base.meses && base.meses.find(m => m.id === id);
  if(!alvo){
    console.error("O mês " + id + " ainda não existe no arquivo. "
                + "Rode buscar-benchmarks.js antes — é ele que cria a linha do mês.");
    process.exit(1);
  }
  let tocou = 0;
  for(const k of Object.keys(out)){
    if(out[k] === null) continue;
    if(alvo.r[k] !== null && alvo.r[k] !== undefined){
      console.log("  · " + k + " já tinha valor (" + alvo.r[k] + ") — não sobrescrevo");
      continue;
    }
    alvo.r[k] = out[k]; tocou++;
  }
  if(tocou){ fs.writeFileSync(ARQ, JSON.stringify(base, null, 1)); console.log("\ngravados: " + tocou); }
  else console.log("\nnada a gravar");

  const faltou = Object.values(out).filter(v => v === null).length;
  process.exit(faltou ? 2 : 0);
}

main().catch(e => { console.error("ERRO: " + e.message); process.exit(1); });
