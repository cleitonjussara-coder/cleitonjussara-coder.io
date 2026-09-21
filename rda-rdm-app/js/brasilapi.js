'use strict';
/* ─────────────────────────────────────────────────────────────
   BrasilAPI.js — consulta CNPJ com 3 camadas de cache
   1. memória (session)  2. Supabase (persistente)  3. BrasilAPI
───────────────────────────────────────────────────────────── */
window.BrasilAPI = (() => {
  const MEM = {};

  function limpar(cnpj) {
    return String(cnpj || '').replace(/\D/g, '').padStart(14, '0');
  }

  function formatar(cnpj) {
    const c = limpar(cnpj);
    if (c.length !== 14 || /^0+$/.test(c)) return cnpj || '';
    return `${c.slice(0,2)}.${c.slice(2,5)}.${c.slice(5,8)}/${c.slice(8,12)}-${c.slice(12,14)}`;
  }

  async function consultar(cnpj, sb) {
    const c = limpar(cnpj);
    if (c.length !== 14 || /^0+$/.test(c)) return null;

    // 1. Cache de memória
    if (MEM[c]) return MEM[c];

    // 2. Cache no servidor (compartilhado pela equipe). Registro antigo sem
    //    CNAE (antes de 16/09/2026) segue para a BrasilAPI uma vez, para
    //    completar — o CNAE é a base da sugestão automática de aba.
    if (sb && navigator.onLine) {
      try {
        const data = await sb.cnpj.get(c);
        if (data && data.cnae) { MEM[c] = data; return data; }
        if (data && !navigator.onLine) { MEM[c] = data; return data; }
      } catch (_) {}
    }

    // 3. BrasilAPI
    if (!navigator.onLine) return null;
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 7000);
      const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${c}`,
        { signal: ctrl.signal });
      clearTimeout(tid);
      if (!r.ok) return null;
      const j = await r.json();
      const res = {
        razao_social : j.razao_social || j.nome || '',
        nome_fantasia: j.nome_fantasia || '',
        cnae         : j.cnae_fiscal ? String(j.cnae_fiscal).replace(/\D/g, '').slice(0, 7) : '',
        cnae_descricao: (j.cnae_fiscal_descricao || '').slice(0, 160),
      };
      MEM[c] = res;
      // persiste no servidor em background
      if (sb) sb.cnpj.set(c, res).catch(() => {});
      return res;
    } catch (_) { return null; }
  }

  return { consultar, limpar, formatar };
})();
