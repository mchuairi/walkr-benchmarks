#!/usr/bin/env node
/*
 * Busca os benchmarks do mês fechado anterior e atualiza benchmarks.json.
 * Camada 1 — Banco Central: público, sem chave, sem cadastro.
 * Regra de ouro: nunca escrever um número que não veio da fonte. Falhou → null.
 *
 * Uso:  node buscar-benchmarks.js            (mês fechado anterior)
 *       node buscar-benchmarks.js 2026-08    (mês específico)
 */
const fs = require("fs");
const ARQ = "benchmarks.json";

/* faixas de sanidade: fora delas o valor é descartado, não gravado */
const FAIXA = { cdi:[0.2,2.5], ipca:[-1.5,2.5], cam:[-25,25] };

const NOMES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho",
               "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

function ultimoDia(ano, mes){ return new Date(Date.UTC(ano, mes, 0)).getUTCDate(); }
function br(ano, mes, dia){ return String(dia).padStart(2,"0")+"/"+String(mes).padStart(2,"0")+"/"+ano; }

async function sgs(serie, ini, fim){
  const url = "https://api.bcb.gov.br/dados/serie/bcdata.sgs."+serie+
              "/dados?formato=json&dataInicial="+ini+"&dataFinal="+fim;
  const r = await fetch(url, {headers:{"Accept":"application/json"}});
  if(!r.ok) throw new Error("SGS "+serie+" devolveu HTTP "+r.status);
  const j = await r.json();
  if(!Array.isArray(j) || !j.length) throw new Error("SGS "+serie+" veio vazia");
  return j;
}
function sane(campo, v){
  const f = FAIXA[campo];
  if(!isFinite(v)) return null;
  if(f && (v < f[0] || v > f[1])){
    console.warn("  ! "+campo+" = "+v+" fora da faixa "+f.join(" a ")+" — gravando null");
    return null;
  }
  return Math.round(v*100)/100;
}

async function main(){
  const arg = process.argv[2];
  const hoje = new Date();
  let ano, mes;
  if(arg && /^\d{4}-\d{2}$/.test(arg)){ ano=+arg.slice(0,4); mes=+arg.slice(5,7); }
  else { const d=new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1));
         d.setUTCDate(0); ano=d.getUTCFullYear(); mes=d.getUTCMonth()+1; }
  const id = ano+"-"+String(mes).padStart(2,"0");
  const nome = NOMES[mes-1]+" de "+ano;
  console.log("Buscando "+nome+"…");

  const ini = br(ano,mes,1), fim = br(ano,mes,ultimoDia(ano,mes));
  const r = {pos:null, pre:null, infl:null, multi:null, fii:null, rv:null, cam:null, cri:null};
  let cdi=null, ipca=null;

  /* --- CDI: SGS 4391 (acumulado no mês) --- */
  try {
    const d = await sgs(4391, ini, fim);
    cdi = sane("cdi", parseFloat(d[d.length-1].valor));
    r.pos = cdi;
    console.log("  CDI: "+cdi+"%");
  } catch(e){ console.warn("  ! CDI NÃO OBTIDO — "+e.message); }

  /* --- IPCA: SGS 433 --- */
  try {
    const d = await sgs(433, ini, fim);
    ipca = sane("ipca", parseFloat(d[d.length-1].valor));
    console.log("  IPCA: "+ipca+"%");
  } catch(e){ console.warn("  ! IPCA NÃO OBTIDO — "+e.message); }

  /* --- Dólar PTAX venda, fim de período: SGS 1 (diária).
         NÃO usar a 3698: ela é a MÉDIA do mês, não o fechamento. --- */
  try {
    const ant = mes===1 ? {a:ano-1,m:12} : {a:ano,m:mes-1};
    const dIni = br(ant.a, ant.m, 1);
    const d = await sgs(1, dIni, fim);
    const doMes = d.filter(x => { const p=x.data.split("/"); return +p[2]===ano && +p[1]===mes; });
    const doAnt = d.filter(x => { const p=x.data.split("/"); return +p[2]===ant.a && +p[1]===ant.m; });
    if(!doMes.length || !doAnt.length) throw new Error("série diária incompleta");
    const fechaAnt = parseFloat(doAnt[doAnt.length-1].valor);
    const fechaMes = parseFloat(doMes[doMes.length-1].valor);
    r.cam = sane("cam", (fechaMes/fechaAnt-1)*100);
    console.log("  PTAX: "+fechaAnt+" → "+fechaMes+" = "+r.cam+"%");
  } catch(e){ console.warn("  ! PTAX NÃO OBTIDO — "+e.message); }

  /* --- Camadas 2 e 3 ainda manuais ---
     pre/infl/multi : ANBIMA (exige cadastro em developers.anbima.com.br)
     rv/cri         : Yahoo Finance (^BVSP, BITH11.SA, interval=1mo)
     fii            : IFIX, B3 — sem fonte automática confiável                */
  ["pre","infl","multi","fii","rv","cri"].forEach(k =>
    console.warn("  ! "+k+" NÃO OBTIDO — fonte ainda não automatizada"));

  /* --- grava --- */
  const base = fs.existsSync(ARQ) ? JSON.parse(fs.readFileSync(ARQ,"utf8"))
                                  : {classes:{}, meses:[]};
  if(base.meses.some(m => m.id===id)){
    console.error("\nO mês "+id+" já existe no arquivo. Mês fechado não é sobrescrito. Nada foi alterado.");
    process.exit(1);
  }
  base.meses.push({id, nome, cdi, ipca, r});
  base.meses.sort((a,b) => a.id < b.id ? -1 : 1);
  while(base.meses.length > 12) base.meses.shift();      /* entra o novo, sai o mais antigo */
  base.atualizado = id;
  base.nomeMes = nome;
  fs.writeFileSync(ARQ, JSON.stringify(base,null,2)+"\n");

  const faltam = Object.keys(r).filter(k => r[k]===null)
    .concat(cdi===null?["cdi"]:[]).concat(ipca===null?["ipca"]:[]);
  console.log("\nGravado em "+ARQ+" ("+base.meses.length+" meses).");
  if(faltam.length){
    console.log("NÃO OBTIDO neste mês: "+faltam.join(", ")+" — preencher à mão antes de publicar.");
    process.exit(2);   /* código != 0 para o GitHub Actions avisar */
  }
}
main().catch(e => { console.error("Falhou: "+e.message); process.exit(1); });
