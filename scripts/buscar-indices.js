#!/usr/bin/env node
/* ===========================================================================
   BENCHMARKS DA CALCULADORA — fonte única: Mais Retorno
   ---------------------------------------------------------------------------
   Substitui as três fontes antigas (Banco Central, ANBIMA e Yahoo) por uma só.
   Resolve de uma vez: o IHFA que a ANBIMA cobrava, o IPCA que o Banco Central
   passou a devolver 404 e o IFIX que era preenchido à mão todo mês.

   COMO USAR
     MAISRETORNO_API_KEY=mr_...  node buscar-indices.js              → mês fechado
     MAISRETORNO_API_KEY=mr_...  node buscar-indices.js 2026-04      → um mês
     MAISRETORNO_API_KEY=mr_...  node buscar-indices.js --descobrir  → só confere
                                   os identificadores, sem gastar crédito nenhum

   CRÉDITOS: /search é grátis e /quotes custa 1. Uma rodada mensal gasta um
   crédito por índice — menos de 10 dos 500 do plano gratuito.

   O QUE ELE NUNCA FAZ: sobrescrever um mês que já tem valor. Mês fechado é
   fechado. Para corrigir um mês na marra, apague o valor do arquivo primeiro.
   =========================================================================== */
"use strict";
const fs = require("fs");

const BASE = "https://data.maisretorno.com/mr-data/v4/api";
const CHAVE = process.env.MAISRETORNO_API_KEY;
const ARQ = process.env.BENCHMARKS || "benchmarks.json";
const DESCOBRIR = process.argv.includes("--descobrir");
const DEBUG = process.argv.includes("--debug");

/* As classes da calculadora e o índice que representa cada uma.
   "busca" é o termo que vai no /search quando o palpite não responder. */
/* Identificadores CONFERIDOS um a um contra a API em 06/10/2026, e os valores
   que eles devolvem batem com as fontes antigas: CDI de set/26 em 1,08% igual
   ao Banco Central, Ibovespa 5,03% e BITH11 6,43% iguais ao Yahoo, e os 40
   valores de IRF-M, IMA-B, IHFA e IFIX que já estavam no arquivo. */
const INDICES = [
  { k: "pos",   nome: "CDI",             palpite: "cdi:idx",    busca: "CDI" },
  { k: "pre",   nome: "IRF-M",           palpite: "irf-m:idx",  busca: "IRF-M" },
  { k: "infl",  nome: "IMA-B",           palpite: "ima-b:idx",  busca: "IMA-B" },
  { k: "multi", nome: "IHFA",            palpite: "ihfa:idx",   busca: "IHFA" },
  { k: "fii",   nome: "IFIX",            palpite: "ifix:idx",   busca: "IFIX" },
  { k: "rv",    nome: "Ibovespa",        palpite: "ibov:idx",   busca: "Ibovespa" },
  { k: "cam",   nome: "Dólar",           palpite: "dolar:idx",  busca: "dolar" },
  { k: "cri",   nome: "Cripto (BITH11)", palpite: "bith11:b3",  busca: "BITH11" },
];
/* o IPCA não é classe da carteira: entra como inflação do período */
const IPCA = { k: "ipca", nome: "IPCA", palpite: "ipca:idx", busca: "IPCA" };

/* ---------------------------------------------------------------- utilidades */
function iso(d){ return d.toISOString().slice(0,10); }
function fim(ano, mes){ return new Date(Date.UTC(ano, mes, 0)); }     // último dia
function ini(ano, mes){ return new Date(Date.UTC(ano, mes-1, 1)); }
function anterior(ano, mes){ return mes === 1 ? {a:ano-1,m:12} : {a:ano,m:mes-1}; }

async function pedir(caminho){
  const r = await fetch(BASE + caminho, { headers: { "X-Api-Key": CHAVE } });
  const txt = await r.text();
  if (DEBUG) console.log("    [" + r.status + "] " + caminho + " → " + txt.slice(0,240));
  if (r.status === 401 || r.status === 403)
    throw new Error("chave recusada (HTTP " + r.status + ") — confira MAISRETORNO_API_KEY");
  if (r.status === 429)
    throw new Error("créditos esgotados ou limite de uso (HTTP 429)");
  if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  try { return JSON.parse(txt); } catch(x){ throw new Error("resposta não é JSON"); }
}

/* Descobre o identificador: tenta o palpite e, se ele não responder, procura
   pelo nome. O /search é grátis, então errar o palpite não custa nada. */
async function identificar(ix){
  try {
    const r = await pedir("/quotes/" + ix.palpite + "?start_date=" + iso(new Date(Date.now()-86400000*10)));
    if (r && (r.quotes || r.shortname)) return { id: ix.palpite, via: "palpite" };
  } catch(e){ /* cai para a busca */ }

  const achados = await pedir("/search/" + encodeURIComponent(ix.busca) + "?has_quotes=true");
  const lista = Array.isArray(achados) ? achados : (achados.results || achados.data || []);
  if (!lista.length) throw new Error("nada encontrado para \"" + ix.busca + "\"");
  const exato = lista.find(x => (x.shortname || "").toUpperCase() === ix.busca.toUpperCase())
             || lista.find(x => (x.identifier || "").endsWith(":idx"))
             || lista[0];
  return { id: exato.identifier, via: "busca", nome: exato.nicename || exato.shortname,
           outros: lista.slice(0,4).map(x => x.identifier + " (" + (x.nicename||"") + ")") };
}

/* A variação do mês sai de dois números-índice: o último dia com cotação do mês
   anterior e o último do mês alvo. É a mesma conta que a ANBIMA fazia. */
async function variacaoDoMes(id, ano, mes){
  const ant = anterior(ano, mes);
  const de  = iso(ini(ant.a, ant.m));
  const ate = iso(fim(ano, mes));
  const r = await pedir("/quotes/" + id + "?start_date=" + de + "&end_date=" + ate);
  const q = (r && r.quotes) || [];
  if (q.length < 2) throw new Error("menos de duas cotações no período"
        + " (o plano gratuito devolve só os últimos 12 meses — mês mais antigo que isso"
        + " precisa ser preenchido à mão)");

  const limite = iso(fim(ant.a, ant.m));
  const antes  = q.filter(x => x.d <= limite);
  const depois = q.filter(x => x.d >  limite);
  if (!antes.length)  throw new Error("sem cotação até o fim de " + ant.m + "/" + ant.a);
  if (!depois.length) throw new Error("sem cotação em " + mes + "/" + ano);

  const a = antes[antes.length-1], b = depois[depois.length-1];
  if (!(a.c > 0) || !(b.c > 0)) throw new Error("cotação zerada ou ausente");
  return { pct: Math.round((b.c/a.c - 1) * 10000) / 100, de: a.d, ate: b.d, va: a.c, vb: b.c };
}

/* ------------------------------------------------------------------- começo */
(async () => {
  if (!CHAVE){ console.error("ERRO: falta MAISRETORNO_API_KEY no ambiente."); process.exit(1); }

  const arg = process.argv.find(x => /^\d{4}-\d{2}$/.test(x));
  let ano, mes;
  if (arg){ ano = +arg.slice(0,4); mes = +arg.slice(5,7); }
  else { const d = new Date(); d.setUTCDate(0); ano = d.getUTCFullYear(); mes = d.getUTCMonth()+1; }
  const alvo = ano + "-" + String(mes).padStart(2,"0");

  console.log("Mais Retorno · " + (DESCOBRIR ? "conferindo os identificadores" : alvo));
  console.log("");

  /* --- modo descoberta: só confere que os índices existem, sem gastar --- */
  if (DESCOBRIR){
    let faltou = 0;
    for (const ix of INDICES.concat([IPCA])){
      try {
        const r = await identificar(ix);
        console.log("  OK   " + ix.nome.padEnd(16) + r.id.padEnd(16) + "(" + r.via + ")");
        if (r.via === "busca" && r.outros)
          console.log("       outros resultados: " + r.outros.join(" · "));
      } catch(e){
        faltou++;
        console.log("  --   " + ix.nome.padEnd(16) + "NÃO ENCONTRADO — " + e.message);
      }
    }
    console.log("\n" + (faltou ? faltou + " índice(s) não encontrado(s)." : "Todos os índices respondem."));
    process.exit(faltou ? 2 : 0);
  }

  /* --- rodada normal --- */
  const base = fs.existsSync(ARQ) ? JSON.parse(fs.readFileSync(ARQ,"utf8")) : [];
  const meses = Array.isArray(base) ? base : (base.meses || []);
  let linha = meses.find(x => x.id === alvo);
  if (!linha){ linha = { id: alvo, r: {} }; meses.push(linha); meses.sort((a,b)=>a.id<b.id?-1:1); }
  linha.r = linha.r || {};

  const out = {};
  let faltou = 0, gravou = 0;
  for (const ix of INDICES){
    if (linha.r[ix.k] !== undefined && linha.r[ix.k] !== null){
      console.log("  ·    " + ix.nome.padEnd(16) + "já tem valor (" + linha.r[ix.k] + "%) — não sobrescrevo");
      continue;
    }
    try {
      const id = (await identificar(ix)).id;
      const v  = await variacaoDoMes(id, ano, mes);
      linha.r[ix.k] = v.pct; out[ix.k] = v.pct; gravou++;
      console.log("  OK   " + ix.nome.padEnd(16) + v.de + " (" + v.va + ") → " + v.ate + " (" + v.vb + ") = " + v.pct + "%");
    } catch(e){
      faltou++;
      console.log("  !    " + ix.nome.padEnd(16) + "NÃO OBTIDO — " + e.message);
    }
  }

  /* IPCA do mês, para a calculadora saber a inflação do período */
  try {
    const id = (await identificar(IPCA)).id;
    const v  = await variacaoDoMes(id, ano, mes);
    if (linha.ipca === undefined || linha.ipca === null){ linha.ipca = v.pct; gravou++; }
    console.log("  OK   " + "IPCA".padEnd(16) + v.pct + "%");
  } catch(e){
    faltou++;
    console.log("  !    " + "IPCA".padEnd(16) + "NÃO OBTIDO — " + e.message);
  }

  if (gravou){
    fs.writeFileSync(ARQ, JSON.stringify(Array.isArray(base) ? meses : base, null, 2) + "\n");
    console.log("\n" + gravou + " valor(es) gravado(s) em " + ARQ + " para " + alvo + ".");
  } else {
    console.log("\nNada novo a gravar em " + alvo + ".");
  }
  if (faltou) console.log(faltou + " índice(s) ficaram sem valor — veja os motivos acima.");
  process.exit(faltou ? 2 : 0);
})().catch(e => { console.error("ERRO: " + e.message); process.exit(1); });
