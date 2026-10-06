#!/usr/bin/env node
/*
 * ANBIMA — IRF-M, IMA-B e IHFA do mês fechado.
 *
 * Regra de ouro, a mesma do resto: número que não veio da fonte vira null.
 * Nunca estimar, nunca interpolar, nunca repetir o mês anterior.
 *
 * Como a conta é feita: a API devolve o NÚMERO-ÍNDICE de um dia.
 * O retorno do mês é (índice do último dia útil do mês ÷ índice do último dia
 * útil do mês anterior − 1) × 100 — a mesma lógica que o script do dólar usa.
 *
 * Uso:
 *   ANBIMA_CLIENT_ID=... ANBIMA_CLIENT_SECRET=... node buscar-anbima.js
 *   node buscar-anbima.js 2026-08          (mês específico)
 *   node buscar-anbima.js 2026-08 --debug  (imprime a resposta crua da API)
 */

/* ambiente: producao (padrão) ou sandbox.
   O sandbox devolve dados FICTÍCIOS — serve só para conferir o formato da
   resposta enquanto a produção não é liberada. Nunca gravar sandbox no site. */
const SANDBOX = process.env.ANBIMA_AMBIENTE === "sandbox";
const BASE  = SANDBOX ? "https://api-sandbox.anbima.com.br" : "https://api.anbima.com.br";
const TOKEN = BASE + "/oauth/access-token";
/* O IHFA estava apontado para "resultados-ihfa", que NAO EXISTE na API: o nome
   do endpoint e "resultados-ihfa-fechado". E como o buscar() trata 404 como
   "dia sem publicacao", o endereco errado virou "a ANBIMA nao publicou" em
   silencio — o IHFA ficou 11 dos 12 meses vazio sem ninguem perceber.
   Os indices tambem vivem em dois grupos ("indices" e "indices-mais") conforme
   o pacote contratado, entao agora o script DESCOBRE qual caminho responde em
   vez de adivinhar, e reclama alto se nenhum responder. */
const IMA_CAMINHOS = [
  BASE + "/feed/precos-indices/v1/indices-mais/resultados-ima",
  BASE + "/feed/precos-indices/v1/indices/resultados-ima"
];
const IHFA_CAMINHOS = [
  BASE + "/feed/precos-indices/v1/indices/resultados-ihfa-fechado",
  BASE + "/feed/precos-indices/v1/indices-mais/resultados-ihfa-fechado",
  BASE + "/feed/precos-indices/v1/indices-mais/resultados-ihfa",
  BASE + "/feed/precos-indices/v1/indices/resultados-ihfa"
];

const DEBUG = process.argv.includes("--debug") || process.env.ANBIMA_DEBUG === "1";

/* ---------- autenticação: OAuth2 client_credentials ---------- */
async function autenticar(){
  const id = process.env.ANBIMA_CLIENT_ID, seg = process.env.ANBIMA_CLIENT_SECRET;
  if(!id || !seg) throw new Error("faltam ANBIMA_CLIENT_ID e ANBIMA_CLIENT_SECRET no ambiente");
  const basic = Buffer.from(id + ":" + seg).toString("base64");
  const r = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Basic " + basic },
    body: JSON.stringify({ grant_type: "client_credentials" })
  });
  if(!r.ok) throw new Error("token devolveu HTTP " + r.status + " — " + (await r.text()).slice(0,200));
  const j = await r.json();
  if(!j.access_token) throw new Error("resposta do token sem access_token");
  return { id: id, token: j.access_token };
}

async function buscar(url, cred, data){
  const r = await fetch(url + "?data=" + data, {
    headers: { "client_id": cred.id, "access_token": cred.token, "Accept": "application/json" }
  });
  if(r.status === 404) return null;               /* dia sem publicação */
  if(!r.ok) throw new Error("HTTP " + r.status + " em " + url);
  const j = await r.json();
  if(DEBUG) console.log("\n--- RESPOSTA CRUA " + url.split("/").pop() + " " + data + " ---\n"
                        + JSON.stringify(j, null, 2).slice(0, 2500) + "\n");
  return j;
}

/* ---------- a API nomeia os campos de formas diferentes por índice;
             procuramos o número-índice entre os nomes plausíveis ---------- */
function numeroIndice(obj){
  const chaves = ["numero_indice","numeroIndice","valor_indice","valorIndice",
                  "indice","valor","numero_indice_fechamento"];
  for(const k of chaves){
    const v = obj && obj[k];
    const n = typeof v === "string" ? parseFloat(v.replace(",",".")) : v;
    if(typeof n === "number" && isFinite(n) && n > 0) return n;
  }
  return null;
}
function achaIndice(resp, nome){
  if(!resp) return null;
  const lista = Array.isArray(resp) ? resp
              : Array.isArray(resp.content) ? resp.content
              : Array.isArray(resp.indices) ? resp.indices : [resp];
  const alvo = nome.toUpperCase().replace(/[^A-Z0-9]/g,"");
  for(const it of lista){
    const rot = String(it.indice || it.nome || it.sigla || it.descricao || "")
                .toUpperCase().replace(/[^A-Z0-9]/g,"");
    if(rot === alvo) return numeroIndice(it);
  }
  return null;
}

/* ---------- datas ---------- */
function iso(d){ return d.toISOString().slice(0,10); }
function ultimoDiaUtilCom(buscaFn, ano, mes){
  /* volta até 12 dias a partir do último dia do mês procurando publicação */
  return (async () => {
    let d = new Date(Date.UTC(ano, mes, 0));
    for(let i=0; i<12; i++){
      const dia = d.getUTCDay();
      if(dia !== 0 && dia !== 6){
        const r = await buscaFn(iso(d));
        if(r) return { data: iso(d), resp: r };
      }
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return null;
  })();
}

/* Testa os caminhos conhecidos em alguns dias uteis e devolve o que responde.
   Separa os tres motivos de falha, que antes se confundiam num null:
     404 em todos os dias  -> caminho errado (ou indice fora do pacote)
     401/403               -> credencial sem permissao para este indice
     200                   -> achou                                        */
async function resolverCaminho(nome, caminhos, cred, datas){
  let viu404 = false, negado = null;
  for(const url of caminhos){
    for(const d of datas){
      let r;
      try{
        r = await fetch(url + "?data=" + d, {
          headers: { "client_id": cred.id, "access_token": cred.token, "Accept": "application/json" }
        });
      }catch(e){ continue; }
      if(r.status === 404){ viu404 = true; continue; }
      if(r.status === 401 || r.status === 403){
        negado = r.status; break;            /* caminho existe, acesso e que falta */
      }
      if(r.ok){
        console.log("  " + nome + " responde em " + url.replace(BASE,""));
        return url;
      }
    }
    if(negado) break;
  }
  if(negado)
    throw new Error(nome + ": acesso negado (HTTP " + negado + "). O caminho existe, "
      + "mas a credencial nao tem permissao para este indice — peca a liberacao do IHFA a ANBIMA.");
  throw new Error(nome + ": nenhum caminho respondeu" + (viu404 ? " (todos deram 404)" : "")
    + ". Testados: " + caminhos.map(u => u.replace(BASE,"")).join(", "));
}

/* alguns dias uteis recentes, para testar o caminho sem depender de um dia especifico */
function diasDeTeste(ano, mes){
  const fora = [];
  let d = new Date(Date.UTC(ano, mes, 0));
  while(fora.length < 4){
    const w = d.getUTCDay();
    if(w !== 0 && w !== 6) fora.push(iso(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return fora;
}

async function main(){
  const arg = process.argv[2];
  let ano, mes;
  if(arg && /^\d{4}-\d{2}$/.test(arg)){ ano = +arg.slice(0,4); mes = +arg.slice(5,7); }
  else { const d = new Date(); d.setUTCDate(0); ano = d.getUTCFullYear(); mes = d.getUTCMonth()+1; }
  const ant = mes === 1 ? { a: ano-1, m: 12 } : { a: ano, m: mes-1 };

  console.log("ANBIMA · " + String(mes).padStart(2,"0") + "/" + ano
              + (SANDBOX ? "  [SANDBOX — dados fictícios, não usar no site]" : ""));
  const cred = await autenticar();
  console.log("  token obtido");

  const out = { pre: null, infl: null, multi: null };
  const teste = diasDeTeste(ano, mes);

  /* --- IMA: traz IRF-M e IMA-B na mesma resposta --- */
  try {
    const IMA = await resolverCaminho("IMA", IMA_CAMINHOS, cred, teste);
    const fim = await ultimoDiaUtilCom(d => buscar(IMA, cred, d), ano, mes);
    const ini = await ultimoDiaUtilCom(d => buscar(IMA, cred, d), ant.a, ant.m);
    if(!fim || !ini) throw new Error("sem publicação do IMA em um dos meses");
    console.log("  IMA: " + ini.data + " → " + fim.data);
    [["pre","IRF-M"], ["infl","IMA-B"]].forEach(([k, nome]) => {
      const a = achaIndice(ini.resp, nome), b = achaIndice(fim.resp, nome);
      if(a && b){
        out[k] = Math.round((b/a - 1) * 10000) / 100;
        console.log("    " + nome + ": " + a + " → " + b + " = " + out[k] + "%");
      } else {
        console.warn("    ! " + nome + " não encontrado na resposta — fica null"
                     + " (rode com --debug para ver os nomes dos campos)");
      }
    });
  } catch(e){ console.warn("  ! IMA NÃO OBTIDO — " + e.message); }

  /* --- IHFA --- */
  try {
    const IHFA = await resolverCaminho("IHFA", IHFA_CAMINHOS, cred, teste);
    const fim = await ultimoDiaUtilCom(d => buscar(IHFA, cred, d), ano, mes);
    const ini = await ultimoDiaUtilCom(d => buscar(IHFA, cred, d), ant.a, ant.m);
    if(!fim || !ini) throw new Error("sem publicação do IHFA em um dos meses");
    const a = achaIndice(ini.resp, "IHFA") || numeroIndice(ini.resp);
    const b = achaIndice(fim.resp, "IHFA") || numeroIndice(fim.resp);
    if(a && b){
      out.multi = Math.round((b/a - 1) * 10000) / 100;
      console.log("  IHFA: " + ini.data + " (" + a + ") → " + fim.data + " (" + b + ") = " + out.multi + "%");
    } else {
      console.warn("  ! IHFA sem número-índice na resposta — fica null"
                   + " (rode com --debug para ver os nomes dos campos)");
    }
  } catch(e){ console.warn("  ! IHFA NÃO OBTIDO — " + e.message); }

  console.log("\nRESULTADO " + String(mes).padStart(2,"0") + "/" + ano + ":");
  console.log(JSON.stringify(out));
  /* saída de máquina, para o buscar-benchmarks.js consumir */
  if(SANDBOX){ console.log("\n[SANDBOX] nada foi gravado — este ambiente só serve para conferir o formato."); process.exit(0); }
  if(process.env.SAIDA_JSON) require("fs").writeFileSync(process.env.SAIDA_JSON, JSON.stringify(out));
  const faltou = Object.values(out).filter(v => v === null).length;
  process.exit(faltou ? 2 : 0);
}

main().catch(e => { console.error("ERRO: " + e.message); process.exit(1); });
