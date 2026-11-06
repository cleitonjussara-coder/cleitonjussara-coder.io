#!/usr/bin/env node
// Teste da fila de envio contra o contrato de conflito do servidor (03/11/2026) — sem navegador e sem servidor.
//   node scripts/testar-sync-conflito.js
// Carrega o db.js e o api.js DE VERDADE num contexto isolado, com um IndexedDB em memória e um fetch simulado.
// Cobre: base_updated_at vem do registro atual; server_updated_at sobrevive às gravações locais; 409 com conflito grava a
// versão do servidor e limpa a fila; 410 remove a nota e a fila (PUT e anexo); erro de rede continua em retentativa;
// service worker (sem window) guarda o aviso; "Enviar agora" conta certo mesmo com rodada extra; o aviso espera o OK;
// pull não troca nota com edição na fila; base do formulário aberto. Sai com 1 se algum caso falhar.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let falhas = 0;
const confere = (ok, msg) => { console.log((ok ? '  ok  ' : '  FALHOU  ') + msg); if (!ok) falhas++; };
const espera = ms => new Promise(r => setTimeout(r, ms));

const js = n => fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', n), 'utf8');
const FONTE_API = js('api.js');
const FONTE_DB = js('db.js');

/* ── IndexedDB em memória: só o que o db.js usa ─────────────── */
const copia = v => {
  if (v === null || typeof v !== 'object' || v instanceof Blob) return v;
  if (Array.isArray(v)) return v.map(copia);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copia(x)]));
};
function criarIndexedDB() {
  const lojas = new Map();
  const pedido = fn => { const r = {}; queueMicrotask(() => { try { r.result = fn(); r.onsuccess?.({ target: r }); } catch (e) { r.error = e; r.onerror?.({ target: r }); } }); return r; };
  const loja = nome => {
    const s = lojas.get(nome);
    return {
      get: k => pedido(() => copia(s.dados.get(k))),
      getAll: () => pedido(() => [...s.dados.values()].map(copia)),
      put: o => pedido(() => { s.dados.set(o[s.chave], copia(o)); return o[s.chave]; }),
      delete: k => pedido(() => { s.dados.delete(k); }),
      index: campo => ({ getAll: v => pedido(() => [...s.dados.values()].filter(o => o[campo] === v).map(copia)) }),
    };
  };
  const banco = {
    objectStoreNames: { contains: n => lojas.has(n) },
    createObjectStore: (n, o) => { lojas.set(n, { chave: o.keyPath, dados: new Map() }); return { createIndex() {} }; },
    transaction: () => ({ objectStore: loja }),
  };
  return {
    open() {
      const r = {};
      setTimeout(() => { r.onupgradeneeded?.({ target: { result: banco } }); r.onsuccess?.({ target: { result: banco } }); }, 0);
      return r;
    },
    _lojas: lojas,
  };
}

/* ── Um aparelho novo: contexto isolado com rede simulada ───── */
const UID = '11111111-1111-4111-8111-111111111111';
function resposta(status, corpo) {
  const txt = corpo === undefined ? '' : JSON.stringify(corpo);
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => txt, json: async () => corpo };
}
function aparelho({ pagina = true } = {}) {
  const rede = { chamadas: [], put: null, foto: null, lista: [], apagadas: [], atraso: 0 };
  /* janela do app (mostrarAviso): fica aberta até o teste chamar ok() ou outra janela tomar o lugar */
  const janela = { abertas: [], outraAberta: false, ok() { const r = this._fechar; this._fechar = null; r?.(); }, _fechar: null };
  const eventos = [];
  const fetchFalso = async (url, op) => {
    const metodo = op.method;
    const caminho = String(url).replace(/^.*\/api/, '').split('?')[0];
    const corpo = typeof op.body === 'string' ? JSON.parse(op.body) : null;
    rede.chamadas.push({ metodo, caminho, corpo, form: typeof op.body === 'string' ? null : op.body });
    if (metodo === 'PUT' && caminho.startsWith('/notas/')) return rede.put ? rede.put(corpo) : resposta(200, { ...corpo, updated_at: 'S-padrao' });
    if (metodo === 'POST' && /\/foto$/.test(caminho)) return rede.foto ? rede.foto() : resposta(200, { foto_path: 'u/x.jpg', updated_at: 'S-foto' });
    if (metodo === 'PUT' && caminho.startsWith('/repasses/') && rede.putRep) return rede.putRep(corpo);
    if (metodo === 'GET' && caminho === '/notas/apagadas') return resposta(200, rede.apagadas);
    if (metodo === 'GET' && caminho === '/notas') { await espera(rede.atraso); return resposta(200, rede.lista); }
    if (metodo === 'GET') return resposta(200, []);
    return resposta(200, {});
  };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, AbortController, Blob, FormData,
    URLSearchParams, crypto: globalThis.crypto, indexedDB: criarIndexedDB(), fetch: fetchFalso,
    navigator: { onLine: true }, location: { hostname: 'localhost', hash: '', search: '', pathname: '/' },
  };
  if (pagina) {
    Object.assign(sandbox, {
      window: { dispatchEvent: e => eventos.push(e), addEventListener() {} },
      document: { hidden: false, addEventListener() {}, getElementById: id => (id === 'modal-pedir' && (janela.outraAberta || janela._fechar) ? {} : null) },
      CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      mostrarAviso: o => new Promise(r => { janela.abertas.push({ ...o, eventosAntes: eventos.map(e => e.type) }); janela._fechar = r; }),
    });
  }
  vm.createContext(sandbox);
  vm.runInContext(FONTE_API, sandbox);
  vm.runInContext(FONTE_DB, sandbox);
  const lojas = sandbox.indexedDB._lojas;
  const ler = (l, id) => lojas.get(l).dados.get(id) || null;
  const fila = () => [...lojas.get('sync_queue').dados.values()];
  const puts = () => rede.chamadas.filter(c => c.metodo === 'PUT');
  return { DB: sandbox.DB, API: sandbox.API, sandbox, rede, janela, eventos, lojas, ler, fila, puts };
}

const notaBase = (id, x) => ({ id, user_id: UID, razao_social: 'Posto Central', valor: 10, tipo: 'rdm', data: '2026-11-01', ...x });
/* nota já no servidor, com a versão S1 conhecida pelo aparelho */
async function notaEnviada(a, id, x) {
  await a.DB.open();
  a.rede.put = c => resposta(200, { ...c, updated_at: 'S1' });
  await a.DB.saveNota(notaBase(id, x), UID);
  await a.DB.sync(a.API, UID, true);
  a.rede.put = null;
  a.rede.chamadas.length = 0;
}

(async () => {
  console.log('server_updated_at e base_updated_at');
  {
    const a = aparelho(); await a.DB.open();
    a.rede.put = c => resposta(200, { ...c, updated_at: 'S1' });
    await a.DB.saveNota(notaBase('n1'), UID);
    await a.DB.sync(a.API, UID, true);
    const primeiro = a.puts()[0]?.corpo || {};
    confere(primeiro.id === 'n1' && !('base_updated_at' in primeiro), 'nota nova vai sem base_updated_at');
    confere(a.ler('notas', 'n1')?.server_updated_at === 'S1', 'PUT aceito guarda o updated_at do servidor');
    confere(a.ler('notas', 'n1')?.sync_status === 'synced' && a.fila().length === 0, 'PUT aceito marca enviado e esvazia a fila');

    /* formulário devolve objeto sem o campo, e outro com valor velho: vale o do registro guardado */
    const { server_updated_at: _s, ...semCampo } = a.ler('notas', 'n1');
    await a.DB.saveNota({ ...semCampo, valor: 20 }, UID);
    confere(a.ler('notas', 'n1')?.server_updated_at === 'S1', 'saveNota preserva server_updated_at com objeto do formulário sem o campo');
    await a.DB.saveNota({ ...semCampo, valor: 21, server_updated_at: 'S-velho' }, UID);
    confere(a.ler('notas', 'n1')?.server_updated_at === 'S1', 'saveNota não troca pelo valor velho que veio no objeto');

    a.rede.chamadas.length = 0;
    a.rede.put = c => resposta(200, { ...c, updated_at: 'S2' });
    await a.DB.sync(a.API, UID, true);
    const corpo = a.puts()[0]?.corpo || {};
    confere(corpo.base_updated_at === 'S1', 'envio manda a base do registro atual');
    confere(!('server_updated_at' in corpo), 'server_updated_at não vai no corpo do PUT');
    confere(corpo.valor === 21, 'o conteúdo enviado é a edição');
    confere(a.ler('notas', 'n1')?.server_updated_at === 'S2', 'base avança depois do PUT aceito');

    await a.DB.softDeleteNota('n1');
    confere(a.ler('notas', 'n1')?.server_updated_at === 'S2', 'exclusão local preserva server_updated_at');
    a.lojas.get('notas').dados.set('n1', { ...a.ler('notas', 'n1'), server_updated_at: 'S3' });   // chegou versão nova depois de arquivar
    await a.DB.restoreNota('n1');
    confere(a.ler('notas', 'n1')?.server_updated_at === 'S3', 'restaurar usa a base do registro vivo, não a do arquivo da lixeira');
  }

  console.log('Edição durante o envio');
  {
    const a = aparelho();
    await notaEnviada(a, 'n2');
    await a.DB.saveNota({ ...a.ler('notas', 'n2'), valor: 30 }, UID);
    a.rede.put = async c => {
      await espera(5);      // o IndexedDB daqui é instantâneo: sem isto os dois carimbos caem no mesmo milissegundo
      await a.DB.saveNota({ ...a.ler('notas', 'n2'), valor: 31 }, UID);     // a pessoa mexeu com o envio no ar
      return resposta(200, { ...c, updated_at: 'S2' });
    };
    await a.DB.sync(a.API, UID, true);
    const n = a.ler('notas', 'n2');
    confere(n?.valor === 31 && n?.synced === false, 'a edição feita no meio do envio não é desfeita');
    confere(n?.server_updated_at === 'S2', 'mesmo assim o registro fica com o updated_at do PUT aceito');
    confere(a.fila().some(i => i.entity === 'nota'), 'a edição nova continua na fila');
    a.rede.chamadas.length = 0;
    a.rede.put = c => resposta(200, { ...c, updated_at: 'S3' });
    await a.DB.tentarDeNovo('n2');
    await a.DB.sync(a.API, UID, true);
    confere(a.puts()[0]?.corpo?.base_updated_at === 'S2', 'a próxima rodada manda a base nova, não a do payload da fila');
  }

  console.log('Mescla do pull');
  {
    const a = aparelho();
    await notaEnviada(a, 'n3');
    a.rede.lista = [{ ...a.ler('notas', 'n3'), valor: 99, updated_at: '2999-01-01T00:00:00.000000Z' }];
    await a.DB.sync(a.API, UID);
    confere(a.ler('notas', 'n3')?.server_updated_at === '2999-01-01T00:00:00.000000Z', 'pull guarda o updated_at do servidor');

    const b = aparelho();
    await notaEnviada(b, 'n4');
    await b.DB.saveNota({ ...b.ler('notas', 'n4'), valor: 40 }, UID);
    /* sem sinal para o PUT, mas o pull passou: a correção da gestão não pode virar base da edição antiga */
    b.rede.put = () => { throw new Error('sem rede'); };
    b.rede.lista = [{ ...b.ler('notas', 'n4'), valor: 77, updated_at: '2999-01-01T00:00:00.000000Z' }];
    await b.DB.sync(b.API, UID);
    confere(b.ler('notas', 'n4')?.server_updated_at === 'S1', 'com edição na fila o pull não avança a base');
    b.rede.chamadas.length = 0;
    b.rede.put = c => resposta(200, { ...c, updated_at: 'S9' });
    await b.DB.forcarEnvio(b.API, UID);
    confere(b.puts()[0]?.corpo?.base_updated_at === 'S1', 'o servidor recebe a base antiga e consegue acusar o conflito');
  }

  console.log('409 com anexo que ainda não subiu');
  {
    /* 04/11/2026: o upload falhou, o PUT tomou 409 e o anexo da edição descartada ficou na fila. Subindo depois, ele cairia
       na espera do servidor sem PUT nenhum, e a próxima edição legítima o promoveria por cima do anexo da gestão. */
    const a = aparelho();
    await notaEnviada(a, 'n5b', { foto_local: 'jpg', foto_path: 'u/n5b.jpg' });
    await a.DB.saveNota({ ...a.ler('notas', 'n5b'), valor: 50 }, UID);
    await a.DB.saveFotoLocal('n5b', new Blob(['abc'], { type: 'image/jpeg' }), 'jpg');
    a.rede.foto = () => resposta(500, { message: 'caiu' });
    a.rede.put = () => resposta(409, {
      message: 'A gestão corrigiu esta nota', conflito: true,
      nota: { id: 'n5b', user_id: UID, razao_social: 'Posto Corrigido', valor: 12, tipo: 'rdm', data: '2026-11-01', foto_path: 'u/n5b.jpg', updated_at: 'S7' },
    });
    await a.DB.sync(a.API, UID, true);
    confere(a.fila().length === 0, 'anexo da edição descartada sai da fila junto');
    confere(a.ler('fotos', 'n5b') === null, 'e o blob sai do aparelho, senão a fila o recoloca');
    a.rede.foto = null; a.rede.chamadas.length = 0;
    await a.DB.forcarEnvio(a.API, UID);      // ignora a espera da nova tentativa do anexo
    confere(!a.rede.chamadas.some(c => /\/foto$/.test(c.caminho)), 'o anexo descartado não sobe na rodada seguinte');
    confere(a.ler('notas', 'n5b')?.foto_path === 'u/n5b.jpg', 'a nota fica com o anexo da gestão');
  }

  console.log('409 conflito');
  {
    const a = aparelho();
    await notaEnviada(a, 'n5', { foto_local: 'jpg', foto_path: 'u/n5.jpg' });
    await a.DB.saveNota({ ...a.ler('notas', 'n5'), valor: 50 }, UID);
    await a.DB.saveFotoLocal('n5', new Blob(['abc'], { type: 'image/jpeg' }), 'jpg');
    a.rede.foto = () => resposta(500, { message: 'caiu' });      // o anexo fica na fila: só o registro sai
    a.rede.put = () => resposta(409, {
      message: 'A gestão corrigiu esta nota', conflito: true,
      nota: { id: 'n5', user_id: UID, razao_social: 'Posto Corrigido', valor: 12, tipo: 'rdm', data: '2026-11-01', foto_path: null, updated_at: 'S7' },
    });
    const r = await a.DB.sync(a.API, UID, true);
    const n = a.ler('notas', 'n5');
    confere(n?.valor === 12 && n?.razao_social === 'Posto Corrigido', 'grava a versão do servidor');
    confere(n?.synced === true && n?.sync_status === 'synced' && !n?.sync_error, 'nota fica como enviada');
    confere(n?.server_updated_at === 'S7' && n?.updated_at === 'S7', 'base nova é a versão devolvida');
    confere(n?.foto_local === 'jpg' && n?.foto_path === 'u/n5.jpg', 'preserva foto_local e não perde o foto_path');
    confere(!a.fila().some(i => i.entity === 'nota'), 'item de registro sai da fila');
    confere(a.fila().some(i => i.entity === 'foto'), 'item do anexo não é tocado');
    confere(r?.fail === 0 && r?.ok === 0, 'conflito não conta como falha nem como enviado');
    const avisos = await a.DB.getMeta('avisos_conflito', []);
    confere(avisos.length === 1 && avisos[0].id === 'n5' && avisos[0].titulo === 'Posto Corrigido' && !!avisos[0].data, 'guarda o aviso em avisos_conflito');
    await espera(20);
    const t = a.janela.abertas.map(x => x.mensagem).join(' | ');
    confere(t.includes('A gestão corrigiu a nota Posto Corrigido. Sua edição anterior foi descartada; confira a nota.'), 'página mostra a janela com o texto combinado');
    a.janela.ok();
    await espera(20);
    confere((await a.DB.getMeta('avisos_conflito', [])).length === 0, 'lista de avisos é limpa depois do OK');
    confere(a.eventos.some(e => e.type === 'db-synced'), 'telas são avisadas para atualizar (rodada leve)');
    a.rede.chamadas.length = 0;
    await a.DB.tentarDeNovo('n5');
    await a.DB.sync(a.API, UID, true);
    confere(a.puts().length === 0, 'nada volta a subir: sem retentativa');
  }
  {
    const a = aparelho();
    await notaEnviada(a, 'n6');
    await a.DB.saveNota({ ...a.ler('notas', 'n6'), valor: 60 }, UID);
    a.rede.put = () => resposta(409, { message: 'Outro motivo' });
    await a.DB.sync(a.API, UID, true);
    confere(a.ler('notas', 'n6')?.valor === 60 && a.fila().length === 1 && a.fila()[0].attempts === 1, '409 sem conflito=true segue como recusa comum');
  }

  console.log('410 apagada');
  {
    const a = aparelho();
    await notaEnviada(a, 'n7');
    await a.DB.saveNota({ ...a.ler('notas', 'n7'), valor: 70 }, UID);
    a.rede.put = () => resposta(410, { message: 'Nota apagada', apagada: true });
    const r = await a.DB.sync(a.API, UID, true);
    confere(a.ler('notas', 'n7') === null, 'PUT 410: cópia local sai');
    confere(a.fila().length === 0, 'PUT 410: fila limpa');
    confere(r?.fail === 0, 'PUT 410: não conta como falha');
    const avisos = await a.DB.getMeta('avisos_conflito', []);
    confere(avisos.length === 1 && avisos[0].texto === 'A nota Posto Central foi apagada pela gestão e saiu deste aparelho.', 'PUT 410: registra o aviso');
    /* o arquivo do Drive é cópia antiga: não pode ressuscitar o que o servidor disse que foi apagado */
    await a.DB.upsertFromDrive('notas', [notaBase('n7')]);
    confere(a.ler('notas', 'n7') === null, 'cópia do Drive não traz de volta a nota apagada');
    await a.DB.upsertFromDrive('notas', [notaBase('n7b')]);
    confere(a.ler('notas', 'n7b') !== null, 'cópia do Drive continua repondo as outras notas');
  }
  {
    const a = aparelho();
    await notaEnviada(a, 'n8');
    await a.DB.saveNota({ ...a.ler('notas', 'n8'), valor: 80 }, UID);
    await a.DB.saveFotoLocal('n8', new Blob(['abc'], { type: 'image/jpeg' }), 'jpg');
    a.rede.foto = () => resposta(410, { message: 'Nota apagada', apagada: true });
    const r = await a.DB.sync(a.API, UID, true);
    confere(a.ler('notas', 'n8') === null && a.ler('fotos', 'n8') === null, 'anexo 410: nota e blob saem');
    confere(a.fila().length === 0, 'anexo 410: todos os itens da nota saem da fila');
    confere(a.puts().length === 0, 'anexo 410: a nota nem tenta subir depois');
    confere(r?.fotosFail === 0 && !r?.erroFoto, 'anexo 410: não vira aviso de falha de anexo');
  }
  {
    const a = aparelho();
    await notaEnviada(a, 'n9');
    await a.DB.softDeleteNota('n9');
    a.rede.put = () => resposta(410, { message: 'Nota apagada', apagada: true });
    await a.DB.sync(a.API, UID, true);
    confere(a.ler('notas', 'n9') === null && a.ler('lancamentos_apagados', 'n9') === null, 'exclusão local + 410: some também da lixeira');
    confere((await a.DB.getMeta('avisos_conflito', [])).length === 0, 'quem já tinha excluído não recebe aviso de perda');
  }

  console.log('Erro comum continua em retentativa');
  {
    const a = aparelho();
    await notaEnviada(a, 'n10');
    await a.DB.saveNota({ ...a.ler('notas', 'n10'), valor: 100 }, UID);
    a.rede.put = () => { throw new Error('sem rede'); };
    const r = await a.DB.sync(a.API, UID, true);
    const n = a.ler('notas', 'n10');
    confere(a.fila().length === 1 && a.fila()[0].status === 'pending' && !!a.fila()[0].last_error, 'falha de rede mantém o item na fila');
    confere(n?.valor === 100 && n?.synced === false && n?.server_updated_at === 'S1', 'falha de rede não mexe na edição nem na base');
    confere(r?.fail === 1, 'falha de rede conta como falha');
    confere((await a.DB.getMeta('avisos_conflito', [])).length === 0, 'falha de rede não gera aviso');

    a.rede.put = () => resposta(500, { message: 'caiu' });
    await a.DB.forcarEnvio(a.API, UID);
    confere(a.fila().length === 1 && a.ler('notas', 'n10')?.valor === 100, '5xx também continua em retentativa');
  }

  console.log('Enviar agora');
  {
    const a = aparelho();
    await notaEnviada(a, 'n11');
    await notaEnviada(a, 'n12');
    await notaEnviada(a, 'n13');
    await a.DB.saveNota({ ...a.ler('notas', 'n11'), valor: 1 }, UID);
    await a.DB.saveNota({ ...a.ler('notas', 'n12'), valor: 2 }, UID);
    await a.DB.saveNota({ ...a.ler('notas', 'n13'), valor: 3 }, UID);
    a.rede.put = c => c.id === 'n11' ? resposta(409, { message: 'x', conflito: true, nota: { ...notaBase('n11'), updated_at: 'S5' } })
      : c.id === 'n12' ? resposta(410, { message: 'x', apagada: true })
      : resposta(200, { ...c, updated_at: 'S6' });
    const r = await a.DB.forcarEnvio(a.API, UID);
    confere(r.restam === 0 && r.falharam === 0 && !r.motivo, 'conflito e apagada não sobram como pendência nem falha');
    confere(r.tinha === 1, `"N enviado(s)" conta só o que subiu de verdade (tinha=${r.tinha})`);
  }
  {
    /* outro gatilho pede sync com o PUT no ar: o descarte é da 1ª rodada, e sync() devolve a última */
    const a = aparelho();
    await notaEnviada(a, 'n15');
    await a.DB.saveNota({ ...a.ler('notas', 'n15'), valor: 1 }, UID);
    a.rede.put = () => { a.DB.sync(a.API, UID, true); return resposta(409, { message: 'x', conflito: true, nota: { ...notaBase('n15'), updated_at: 'S5' } }); };
    const r = await a.DB.forcarEnvio(a.API, UID);
    confere(r.tinha === 0 && r.restam === 0, `rodada extra não faz a nota descartada contar como enviada (tinha=${r.tinha})`);
  }

  console.log('Aviso de edição descartada não some');
  {
    const a = aparelho();
    await notaEnviada(a, 'n16');
    await a.DB.saveNota({ ...a.ler('notas', 'n16'), valor: 1 }, UID);
    a.rede.put = () => resposta(409, { message: 'x', conflito: true, nota: { ...notaBase('n16'), updated_at: 'S5' } });
    a.rede.atraso = 60;                            // pull lento: rede ruim é o caso comum
    await a.DB.forcarEnvio(a.API, UID);
    await espera(20);
    confere(a.janela.abertas.length === 1, 'abre a janela uma vez');
    confere(a.janela.abertas[0]?.eventosAntes.includes('db-synced'), 'só abre depois do pull e do db-synced');
    /* o toast "Nada pendente"/"Sincronizado" não alcança a janela: ela espera o OK */
    await a.DB.sync(a.API, UID);
    await espera(20);
    confere(a.janela.abertas.length === 1, 'outra rodada não abre a mesma janela de novo');
    confere((await a.DB.getMeta('avisos_conflito', [])).length === 1, 'sem o OK a lista continua guardada');
    a.janela.ok();
    await espera(20);
    confere((await a.DB.getMeta('avisos_conflito', [])).length === 0, 'com o OK a lista é limpa');
    await a.DB.sync(a.API, UID);
    await espera(20);
    confere(a.janela.abertas.length === 1, 'depois do OK não volta');
  }
  {
    const a = aparelho();
    await notaEnviada(a, 'n17');
    await a.DB.saveNota({ ...a.ler('notas', 'n17'), valor: 1 }, UID);
    a.rede.put = () => resposta(409, { message: 'x', conflito: true, nota: { ...notaBase('n17'), updated_at: 'S5' } });
    /* a janela é uma vaga só: abrir por cima cancelaria a pergunta que a pessoa está respondendo */
    a.janela.outraAberta = true;
    await a.DB.sync(a.API, UID, true);
    await espera(20);
    confere(a.janela.abertas.length === 0, 'não abre por cima de outra janela do app');
    a.janela.outraAberta = false;
    a.sandbox.document.hidden = true;
    await a.DB.sync(a.API, UID);
    await espera(20);
    confere(a.janela.abertas.length === 0, 'não abre com o app em segundo plano');
    a.sandbox.document.hidden = false;
    await a.DB.sync(a.API, UID);
    await espera(20);
    confere(a.janela.abertas.length === 1, 'abre na rodada seguinte');
    /* outra janela tomou a vaga: fechou sem a pessoa tocar em OK */
    a.janela.outraAberta = true;
    a.janela.ok();
    await espera(20);
    confere((await a.DB.getMeta('avisos_conflito', [])).length === 1, 'janela substituída por outra não conta como lida');
    a.janela.outraAberta = false;
    await a.DB.sync(a.API, UID);
    await espera(20);
    confere(a.janela.abertas.length === 2, 'e o aviso volta depois');
  }

  console.log('Pull com edição na fila');
  const FUTURO = '2999-01-01T00:00:00.000000Z';
  const adiarFila = a => { for (const i of a.fila()) a.lojas.get('sync_queue').dados.set(i.id, { ...i, next_attempt_at: new Date(Date.now() + 600_000).toISOString() }); };
  {
    /* a pessoa nunca vê a versão da gestão enquanto a edição dela está na fila: quem julga é o servidor */
    const a = aparelho();
    await notaEnviada(a, 'n18');
    await a.DB.saveNota({ ...a.ler('notas', 'n18'), valor: 50 }, UID);
    adiarFila(a);
    a.rede.lista = [{ ...notaBase('n18'), valor: 99, updated_at: FUTURO }];
    await a.DB.setMeta('last_sync', '2026-01-01T00:00:00.000Z');
    const r = await a.DB.sync(a.API, UID);
    const n = a.ler('notas', 'n18');
    confere(n?.valor === 50 && n?.synced === false && n?.server_updated_at === 'S1' && a.fila().length === 1, 'pull não troca o conteúdo da nota com edição na fila');
    confere(r?.pulled === 0, 'nota deixada de lado não conta como recebida');
    await a.DB.saveNota({ ...n, observacao: 'mais um ajuste' }, UID);
    a.rede.chamadas.length = 0;
    a.rede.lista = [];        // aceito o PUT, o servidor já não tem a versão anterior
    a.rede.put = c => resposta(200, { ...c, updated_at: 'S2' });
    await a.DB.forcarEnvio(a.API, UID);
    const c = a.puts()[0]?.corpo || {};
    confere(c.valor === 50 && c.observacao === 'mais um ajuste' && c.base_updated_at === 'S1', 'envio leva a edição inteira com a base antiga');
    const f = a.ler('notas', 'n18');
    confere(f?.valor === 50 && f?.server_updated_at === 'S2' && f?.synced === true, 'servidor aceitou: o aparelho fica igual ao que subiu');
  }
  {
    const a = aparelho();
    await notaEnviada(a, 'n19');
    await a.DB.softDeleteNota('n19');
    adiarFila(a);
    a.rede.lista = [{ ...notaBase('n19'), deleted: false, updated_at: FUTURO }];
    await a.DB.setMeta('last_sync', '2026-01-01T00:00:00.000Z');
    await a.DB.sync(a.API, UID);
    confere(a.ler('notas', 'n19')?.deleted === true, 'exclusão na fila não é desfeita pelo pull');
  }
  {
    /* sem item na fila o pull continua valendo */
    const a = aparelho();
    await notaEnviada(a, 'n20');
    a.rede.lista = [{ ...notaBase('n20'), valor: 99, updated_at: FUTURO }];
    await a.DB.setMeta('last_sync', '2026-01-01T00:00:00.000Z');
    const r = await a.DB.sync(a.API, UID);
    confere(a.ler('notas', 'n20')?.valor === 99 && r?.pulled >= 1, 'sem edição na fila o pull troca o conteúdo');
  }

  console.log('Base do formulário aberto (precisa do app.js mandar base_formulario)');
  {
    const a = aparelho();
    await notaEnviada(a, 'n21');
    a.rede.lista = [{ ...notaBase('n21'), valor: 99, updated_at: FUTURO }];
    await a.DB.setMeta('last_sync', '2026-01-01T00:00:00.000Z');
    await a.DB.sync(a.API, UID);
    confere(a.ler('notas', 'n21')?.server_updated_at === FUTURO, 'a correção chegou com o formulário aberto');
    await a.DB.saveNota({ ...notaBase('n21'), valor: 10, base_formulario: 'S1' }, UID);
    const n = a.ler('notas', 'n21');
    confere(n?.server_updated_at === 'S1' && !('base_formulario' in n), 'base volta a ser a da abertura e o campo não fica guardado');
    a.rede.chamadas.length = 0;
    a.rede.put = () => resposta(409, { message: 'x', conflito: true, nota: { ...notaBase('n21'), valor: 99, updated_at: FUTURO } });
    await a.DB.sync(a.API, UID, true);
    const c = a.puts()[0]?.corpo || {};
    confere(c.base_updated_at === 'S1' && !('base_formulario' in c), 'o PUT leva a base da abertura e o servidor consegue acusar');
    confere(a.ler('notas', 'n21')?.valor === 99 && (await a.DB.getMeta('avisos_conflito', [])).length === 1, 'a correção vence e a pessoa é avisada');
  }

  /* 04/11/2026: o PUT que troca o dono move o anexo no servidor. A fila regravava o registro com o caminho velho e carimbava
     a hora do aparelho, mais nova que a do servidor (segundos inteiros): o pull não corrigia e o gestor via "Anexo não encontrado". */
  console.log('Caminho do anexo devolvido pelo PUT');
  {
    const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const emSegundos = () => new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', '.000000Z');
    const notaDeA = async (a, id) => {
      await a.DB.open();
      const velho = new Date(Date.now() - 86400e3).toISOString();
      a.rede.lista = [{ ...notaBase(id), user_id: A, foto_path: `${A}/${id}.jpg`, updated_at: velho, created_at: velho }];
      await a.DB.sync(a.API, UID);
      return a.ler('notas', id);
    };

    const a = aparelho();
    await a.DB.saveNota({ ...await notaDeA(a, 'n30'), user_id: B }, UID);
    let linha = null;
    a.rede.put = c => { linha = { ...c, foto_path: `${B}/n30.jpg`, updated_at: emSegundos() }; return resposta(200, linha); };
    await a.DB.sync(a.API, UID, true);
    confere(a.ler('notas', 'n30')?.foto_path === `${B}/n30.jpg`, 'PUT aceito grava o caminho novo no aparelho');
    confere(a.ler('notas', 'n30')?.server_updated_at === linha.updated_at && a.fila().length === 0, 'a versão do servidor e a fila seguem como antes');
    confere(!('foto_path' in (a.puts()[0]?.corpo || {})) || a.puts()[0].corpo.foto_path === `${A}/n30.jpg`, 'o aparelho não inventa caminho no PUT');
    a.rede.put = null;
    a.rede.lista = [linha];
    await a.DB.sync(a.API, UID);
    confere(a.ler('notas', 'n30')?.foto_path === `${B}/n30.jpg`, 'o pull seguinte não volta o caminho velho');

    const b = aparelho();
    await b.DB.saveNota({ ...await notaDeA(b, 'n31'), valor: 20 }, UID);
    b.rede.put = c => resposta(200, { ...c, foto_path: null, updated_at: emSegundos() });
    await b.DB.sync(b.API, UID, true);
    confere(b.ler('notas', 'n31')?.foto_path === `${A}/n31.jpg`, 'null do servidor não apaga a referência (mesma exceção do pull)');

    const c = aparelho();
    await c.DB.saveNota({ ...await notaDeA(c, 'n32'), user_id: B }, UID);
    let puts = 0;
    c.rede.put = async corpo => {
      /* a espera garante outro milissegundo: é pelo updated_at que a fila percebe a edição */
      if (++puts === 1) { await espera(5); await c.DB.saveNota({ ...c.ler('notas', 'n32'), valor: 77 }, UID); }
      return resposta(200, { ...corpo, foto_path: `${B}/n32.jpg`, updated_at: emSegundos() });
    };
    await c.DB.sync(c.API, UID, true);
    await espera(5);
    await c.DB.sync(c.API, UID, true);
    const n32 = c.ler('notas', 'n32');
    confere(n32?.valor === 77 && n32?.foto_path === `${B}/n32.jpg` && c.fila().length === 0, 'edição feita com o PUT no ar sobe e o caminho novo entra no envio dela');
  }

  console.log('Mês fechado: 423 com mes_fechado (06/11/2026)');
  {
    const corpo423 = (nota, x) => ({ message: 'x', mes_fechado: true, ano: 2026, mes: 10, mes_rotulo: 'outubro/2026', nota, ...x });

    /* edição de nota existente: vale a do servidor e o item sai da fila */
    const a = aparelho();
    await notaEnviada(a, 'm1', { razao_social: 'Posto Sul' });
    await a.DB.saveNota({ ...a.ler('notas', 'm1'), valor: 99 }, UID);
    a.rede.put = () => resposta(423, corpo423({ ...notaBase('m1', { razao_social: 'Posto Sul' }), valor: 10, foto_path: 'u/m1.jpg', updated_at: 'S2' }));
    const r = await a.DB.sync(a.API, UID, true);
    const m1 = a.ler('notas', 'm1');
    confere(m1?.valor === 10 && m1?.synced === true && m1?.server_updated_at === 'S2', '423 grava a versão do servidor');
    confere(a.fila().length === 0, 'item sai da fila');
    confere(!r?.fail, 'não conta como falha');
    const avisos = await a.DB.getMeta('avisos_conflito', []);
    confere(avisos.length === 1 && avisos[0].texto === 'O mês de outubro/2026 foi fechado pela gestão. Sua alteração na nota Posto Sul não foi gravada; fale com o gestor.', 'aviso com o mês e a nota');
    const chamadas = a.puts().length;
    await a.DB.sync(a.API, UID, true);
    confere(a.puts().length === chamadas, 'rodada seguinte não reenvia');

    /* sem mes_rotulo o mês sai da data da nota */
    const b = aparelho();
    await notaEnviada(b, 'm2', { razao_social: 'Hotel', data: '2026-09-03' });
    await b.DB.saveNota({ ...b.ler('notas', 'm2'), valor: 5 }, UID);
    b.rede.put = () => resposta(423, { message: 'x', mes_fechado: true, nota: { ...notaBase('m2', { razao_social: 'Hotel', data: '2026-09-03' }), foto_path: 'u/m2.jpg', updated_at: 'S2' } });
    await b.DB.sync(b.API, UID, true);
    confere((await b.DB.getMeta('avisos_conflito', []))[0]?.texto.includes('setembro/2026'), 'mês vem da data quando o servidor não manda o rótulo');

    /* nota NOVA nunca é recusada: entra, e o aparelho a guarda como sempre */
    const c = aparelho(); await c.DB.open();
    c.rede.put = co => resposta(200, { ...co, updated_at: 'S1', fora_fechamento_em: '2026-11-06T12:00:00Z' });
    await c.DB.saveNota(notaBase('m3', { data: '2026-10-02' }), UID);
    await c.DB.sync(c.API, UID, true);
    confere(c.ler('notas', 'm3')?.synced === true && c.fila().length === 0, 'nota nova de mês fechado sobe normalmente');
    confere((await c.DB.getMeta('avisos_conflito', [])).length === 0, 'nota nova não gera aviso de recusa');

    /* anexo de nota existente, com o servidor já tendo o dele */
    const d = aparelho();
    await notaEnviada(d, 'm4', { foto_path: 'u/m4.jpg' });
    const blob = new Blob(['novo'], { type: 'image/jpeg' });
    await d.DB.saveFotoLocal('m4', blob, 'jpg');
    await d.DB.saveNota({ ...d.ler('notas', 'm4'), valor: 7 }, UID);
    d.rede.foto = () => resposta(423, corpo423({ ...notaBase('m4'), foto_path: 'u/m4.jpg', updated_at: 'S2' }));
    await d.DB.sync(d.API, UID, true);
    confere(d.fila().length === 0, 'anexo recusado solta anexo e nota da fila');
    confere(!d.ler('fotos', 'm4'), 'anexo novo sai junto: o servidor tem o comprovante');
    confere((await d.DB.getMeta('avisos_conflito', [])).length === 1, 'um aviso só para anexo e nota');

    /* nota de mês aberto movida para mês fechado com anexo novo: o servidor recusa pelo anexo, antes de ele tocar no comprovante */
    const d2 = aparelho();
    await notaEnviada(d2, 'm4b', { data: '2026-11-03', foto_path: 'u/m4b.jpg' });
    await d2.DB.saveFotoLocal('m4b', new Blob(['novo'], { type: 'image/jpeg' }), 'jpg');
    await d2.DB.saveNota({ ...d2.ler('notas', 'm4b'), data: '2026-10-20' }, UID);
    d2.rede.foto = () => resposta(423, corpo423({ ...notaBase('m4b', { data: '2026-11-03' }), foto_path: 'u/m4b.jpg', updated_at: 'S2' }));
    await d2.DB.sync(d2.API, UID, true);
    confere(d2.rede.chamadas.find(x => /\/foto$/.test(x.caminho))?.form?.get('data') === '2026-10-20', 'o anexo sobe dizendo a data da edição');
    confere(d2.ler('notas', 'm4b')?.data === '2026-11-03' && d2.fila().length === 0, 'volta à versão do servidor e sai da fila');
    confere(!d2.puts().length, 'o PUT nem sai: o anexo já disse que não entra');

    /* servidor sem anexo: o arquivo é a única cópia, fica guardado sem voltar para a fila */
    const e = aparelho();
    await notaEnviada(e, 'm5');
    await e.DB.saveFotoLocal('m5', new Blob(['unica'], { type: 'image/jpeg' }), 'jpg');
    e.rede.foto = () => resposta(423, corpo423({ ...notaBase('m5'), foto_path: null, updated_at: 'S2' }));
    await e.DB.sync(e.API, UID, true);
    confere(e.ler('fotos', 'm5')?.recusada === true, 'única cópia do anexo fica guardada e marcada');
    confere(e.fila().length === 0, 'e não fica na fila');
    e.rede.chamadas.length = 0;
    await e.DB.sync(e.API, UID, true);
    confere(!e.rede.chamadas.some(x => /\/foto$/.test(x.caminho)), 'rodada seguinte não sobe o anexo de novo');

    /* repasse */
    const f = aparelho(); await f.DB.open();
    const rep = { id: 'r1', user_id: UID, tipo: 'RDM', valor: 50, data: '2026-10-05', mes: 10, ano: 2026, kind: 'received' };
    await f.DB.saveRepasse(rep, UID);
    f.rede.putRep = () => resposta(423, { message: 'Reabra o mês.', mes_fechado: true, mes_rotulo: 'outubro/2026', repasse: null });
    await f.DB.sync(f.API, UID, true);
    confere(f.fila().length === 0, 'repasse novo recusado sai da fila');
    confere(f.ler('repasses', 'r1')?.deleted === true, 'e sai da conta deste aparelho, sem ser apagado');
    confere((await f.DB.getMeta('avisos_conflito', []))[0]?.texto === 'Reabra o mês.', 'aviso traz o que o servidor disse');

    const g = aparelho(); await g.DB.open();
    await g.DB.saveRepasse({ ...rep, id: 'r2' }, UID);
    g.rede.putRep = () => resposta(423, { message: 'x', mes_fechado: true, mes_rotulo: 'outubro/2026', repasse: { ...rep, id: 'r2', valor: 40 } });
    await g.DB.sync(g.API, UID, true);
    confere(g.ler('repasses', 'r2')?.valor === 40 && g.fila().length === 0, 'repasse existente volta à versão do servidor');

    /* 423 desconhecido não some em silêncio: fica com o motivo e espera longa, como as outras recusas */
    const h = aparelho();
    await notaEnviada(h, 'm6');
    await h.DB.saveNota({ ...h.ler('notas', 'm6'), valor: 3 }, UID);
    h.rede.put = () => resposta(423, { message: 'Travado por outro motivo' });
    await h.DB.sync(h.API, UID, true);
    confere(h.ler('notas', 'm6')?.sync_error === 'Travado por outro motivo', '423 sem mes_fechado mostra o motivo');
    confere(h.ler('notas', 'm6')?.valor === 3 && h.fila().length === 1, 'e não descarta a edição');

    /* service worker não tem tela */
    const w = aparelho({ pagina: false });
    await w.DB.open();
    await w.DB.setMeta('sessao_fundo', { token: 't', uid: UID });
    w.rede.put = c2 => resposta(200, { ...c2, updated_at: 'S1' });
    await w.DB.saveNota(notaBase('m7'), UID);
    await w.DB.enviarEmFundo({ prazoMs: 2000 });
    await w.DB.saveNota({ ...w.ler('notas', 'm7'), valor: 5 }, UID);
    w.rede.put = () => resposta(423, corpo423({ ...notaBase('m7'), foto_path: 'u/m7.jpg', valor: 6, updated_at: 'S2' }));
    const rw = await w.DB.enviarEmFundo({ prazoMs: 2000 });
    confere(w.ler('notas', 'm7')?.valor === 6 && w.fila().length === 0 && rw.fail === 0, 'worker aplica o 423 sem quebrar');
    confere((await w.DB.getMeta('avisos_conflito', [])).length === 1, 'aviso espera a página');
  }

  console.log('Service worker (sem window, document nem toast)');
  {
    const a = aparelho({ pagina: false });
    await a.DB.open();
    await a.DB.setMeta('sessao_fundo', { token: 't', uid: UID });
    a.rede.put = c => resposta(200, { ...c, updated_at: 'S1' });
    await a.DB.saveNota(notaBase('n14'), UID);
    await a.DB.enviarEmFundo({ prazoMs: 2000 });
    await a.DB.saveNota({ ...a.ler('notas', 'n14'), valor: 5 }, UID);
    a.rede.put = () => resposta(409, { message: 'x', conflito: true, nota: { ...notaBase('n14'), valor: 6, updated_at: 'S2' } });
    const r = await a.DB.enviarEmFundo({ prazoMs: 2000 });
    confere(a.ler('notas', 'n14')?.valor === 6 && a.fila().length === 0, 'worker aplica o conflito sem quebrar');
    confere(r.fail === 0, 'worker não conta falha');
    confere((await a.DB.getMeta('avisos_conflito', [])).length === 1, 'aviso fica guardado para a página mostrar');
  }

  console.log(falhas ? `\n${falhas} caso(s) FALHARAM` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('ERRO NO TESTE:', e); process.exit(1); });
