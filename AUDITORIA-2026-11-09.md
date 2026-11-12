# Auditoria do sistema — 09/11/2026

Base auditada: **origin/main a226be4 (build 603, o que está em produção)**. A pasta local está no build 601.
Só leitura: nenhum código foi alterado.
O pente fino de 03/11 (build 516) já foi corrigido e encerrado. Esta auditoria cobre o que entrou depois (builds 517–603)
e revisa de novo os pontos sensíveis: login, permissões, anexos, backup, IA, campo, busca, front e layout.

## Resumo

O sistema está maduro. As permissões são checadas no servidor e o Contador fica em modo só leitura por middleware.
Os anexos usam URL assinada e caminho validado. O front escapa o HTML de forma consistente, e o pdf.js já tem a mitigação da CVE-2024-4367.
No celular, nenhuma tela testada passou da largura.
Não achei falha grave de segurança. Os riscos que mais pesam são de **operação**: publicar a partir da pasta errada, custo da IA sem limite e registro de campo com hora retroativa.

| # | Prioridade | Área | Achado |
|---|---|---|---|
| 1 | **Alta** | Operação | Pasta local 2 builds atrás da produção, com 4 arquivos sem commit; o `publicar.sh` não confere o git |
| 2 | ~~Média~~ Baixa | Custo | Leitura por IA tinha teto diário, mas não limite por minuto — **corrigido na branch** |
| 3 | **Média** | Integridade | Atividade em campo aceita hora do aparelho sem limite para trás |
| 4 | **Média** | Desempenho | `/atividades-campo/equipe` lê o histórico inteiro a cada abertura |
| 5 | **Média** | Operação | "Migrar" pelo app roda sem backup antes — **corrigido na branch** |
| 6 | **Média** | Qualidade | ESLint com 55 falsos erros: a rede que pegaria o bug do build 595 está furada — **corrigido na branch** |
| 7 | Média | Dependências | 2 alertas novos do Symfony (04/11) no `composer audit` |
| 8 | Baixa | Segurança | Login revela "conta desativada" antes de conferir a senha |
| 9 | Baixa | Segurança | Login Google liga a conta pelo e-mail sem conferir `email_verified` |
| 10 | Baixa | Segurança | Scripts de CDN sem SRI; app sem Content-Security-Policy |
| 11 | Baixa | Robustez | `observacao` e `qr_url` sem tamanho máximo no PUT /notas |
| 12 | Baixa | Robustez | Service worker guarda no cache resposta de erro da CDN |
| 13 | Baixa | Desempenho | Lixeira de campos faz 1 consulta por campo (N+1) |
| 14 | Baixa | Visual | Valores grandes quebram no meio do número em tela de 320 px |
| 15 | **Média** | Disponibilidade | Todo `throttle:N,1` sem prefixo divide um único contador por pessoa (ou por IP, sem login) |

---

## 1. Pasta local atrás da produção — ALTA

- Local: `main` em **5f136dc (build 601)**. Produção e GitHub: **a226be4 (build 603)**, com a lixeira do campo e a "nota sem QR começa pelo comprovante".
- Há 4 arquivos modificados sem commit: `LeitorNota.php`, `LeitorNotaTest.php`, `ocr.js` e `scripts/testar-ocr-pedagio.js`.
- O `scripts/publicar.sh` não roda nenhum comando git. Publicar desta pasta agora **devolveria a produção ao 601**: as rotas da lixeira sumiriam, e a migração 000004 continuaria no banco.

**Correção:** antes de publicar, rode `git pull` (ou um rebase do trabalho do OCR sobre a origin/main). No `publicar.sh`, recuse a publicação se `HEAD` estiver atrás de `origin/main` ou se houver arquivo modificado. Isso combina com a regra "publicar de cópia limpa".

## 2. IA de visão sem limite por minuto — BAIXA (corrigido na branch)

Revisão: o achado original estava exagerado. As duas rotas **já tinham teto diário por pessoa**: 80 notas (`NOTA_IA_LIMITE_DIA`) e 30 odômetros (`ODOMETRO_IA_LIMITE_DIA`) por dia. Faltava só o limite de rajada.
**Feito:** `throttle:20,1,ia-nota` e `throttle:20,1,ia-km`, cada um com contador próprio (ver o item 15).

## 3. Atividade em campo com hora retroativa — MÉDIA

`AtividadeCampoController::hora()` recusa hora no futuro (+5 min), mas aceita qualquer hora no passado.
Um colaborador pode registrar "início" e "fim" de ontem, ou da semana passada, como se estivesse em campo. A localização também vem do aparelho.
Para um registro que serve de prova de presença, isso enfraquece o dado.

> Esclarecimento do Cleiton (11/11/2026): o registro é feito na hora e serve para a segurança da equipe, não como prova de presença. Se o colaborador passar mal dentro do campo, a empresa precisa saber onde ele está. Por isso o limite de 24 h e o selo "registrado depois" servem para o gestor saber se a localização que está vendo é recente.

**Correção (decisão sua):** aceitar hora do aparelho até um limite (ex.: 24 h, o suficiente para a fila offline). Gravar também quando o servidor recebeu. Mostrar ao gestor um selo "registrado depois (offline)" quando a diferença passar de ~15 min.

## 4. Painel "equipe em campo" lê tudo — MÉDIA

`equipe()` faz `whereIn(user_id)->orderByDesc('inicio')->get()` sem limite e só depois pega o primeiro de cada pessoa.
A cada abertura, ele carrega todos os registros de campo da história. Hoje é rápido; daqui a alguns meses, não será.

**Correção:** subconsulta com `MAX(inicio)` por `user_id`, ou um limite de 60 dias (quem está sem registro há mais tempo aparece como "sem registro recente").

## 5. "Migrar" pelo app sem backup — MÉDIA (corrigido na branch)

`POST /admin/migrar` roda `migrate --force` direto. A skill `migrar-banco` manda fazer backup antes, mas o botão do app pula esse passo.

**Correção:** chamar `BackupCompleto::copiarBanco()` (ou `backup:gerar --so-banco`) antes do `migrate` e devolver o nome do arquivo na resposta.

## 6. ESLint furado — MÉDIA (corrigido na branch)

`npx eslint js/*.js` dá **68 erros**. Desses, 55 são `no-undef` de 28 nomes que existem em outro arquivo, mas faltam na lista `doApp` do `eslint.config.mjs`. Exemplos: `_acompanhaCampo`, `Fechamento`, `CATEGORIAS_TODAS`, `notas`, `_ehCV`, `editarNota`, `abrirAjuda`.
Conferi um por um: **todos existem hoje**, então não há bug ativo.
O próprio config avisa: "o que faltar aqui é bug, não ruído". Com 55 alarmes falsos, um nome que sumir de verdade passa despercebido. Foi exatamente o caso do `_acompanhaCampo` perdido no merge do build 588, que travou a Atividade em campo (595–596).
Os outros 13 avisos são inofensivos: 9 `no-useless-assignment`, 4 `no-useless-escape` e 6 `no-unused-vars`.

**Correção:** acrescentar os 28 nomes ao config, deixar o lint zerado e incluir `eslint` no checklist do `publicar.sh` (falhou, não publica).

## 7. Dependências PHP — MÉDIA

`composer audit` aponta dois alertas publicados em 04/11:
- `symfony/routing`: CVE-2026-118516 (placeholder de host no matcher compilado);
- `symfony/http-kernel`: CVE-2026-123339 (fragmentos inline e cabeçalhos Forwarded).

O impacto prático no Laravel é baixo: não usamos rota por host nem fragment inline. Mesmo assim, a atualização é barata: `composer update "symfony/*"`, rodar os testes e publicar com `--vendor`.

## 8. Login revela conta desativada — BAIXA

Em `AuthController::login`, "Conta desativada" sai **antes** da conferência da senha. Quem só sabe o e-mail descobre que a pessoa já trabalhou na empresa.
**Correção:** conferir a senha primeiro e só depois avisar que a conta está desativada. Vale também aplicar `trim()` no e-mail, como o cadastro já faz.

## 9. Login Google sem `email_verified` — BAIXA

O callback liga a conta Google a um colaborador existente pelo e-mail sem olhar `email_verified` do userinfo.
Contas Gmail são sempre verificadas, então o risco é teórico. Mesmo assim, é uma linha: `abort_unless($info['email_verified'] ?? false, …)`.

## 10. CDN sem SRI e app sem CSP — BAIXA

jsQR, Tesseract, Quagga, SheetJS e pdf.js vêm da CDN com versão fixa, mas sem `integrity`. Se a CDN for comprometida, o script entra com o token do usuário no `localStorage`.
**Correção:** adicionar `integrity` + `crossorigin` nos `<script>`, ou servir as bibliotecas do próprio domínio.
A CSP completa esbarra nos `onclick` inline (são centenas). Um primeiro passo possível é uma CSP só com `script-src` restrito aos domínios usados mais `'unsafe-inline'`, que já barra script de domínio estranho.

## 11. Campos sem tamanho máximo — BAIXA

No PUT /notas, `observacao` e `qr_url` são `string` sem `max`. Um cliente com defeito pode gravar megabytes por nota, que vão para o backup e para o ZIP.
**Correção:** `max:2000` e `max:1000`. Para o aparelho antigo não travar a fila com 422, cortar o texto em vez de recusar.

## 12. Service worker guarda erro da CDN — BAIXA

No `sw.js`, o ramo da CDN faz `c.put(e.request, r.clone())` sem conferir `r.ok`. Um 503 da jsDelivr fica no cache e é servido até a próxima revalidação dar certo.
**Correção:** `if (r.ok) c.put(...)`.

## 13. Lixeira de campos N+1 — BAIXA

`lixeiraCampos()` chama `registrosDoCampo()` para cada campo apagado (até 500 consultas). É irrelevante com poucos campos; vale agrupar quando a lista crescer.

## 14. Visual: número quebrado no celular — BAIXA

A 320 px, com valor grande, o cartão "Cartão" do Início mostra `R$ 599.999,9` e o `4` cai sozinho na linha de baixo. A pílula "saldo -" também separa o sinal do valor.
**Correção:** tamanho de fonte com `clamp()` no valor do cartão e `white-space:nowrap` só no número (o cartão já tem `min-width:0`).

---

## 15. Limites de requisição dividem o mesmo contador — MÉDIA

O `ThrottleRequests` do Laravel monta a chave só com o id do usuário. Sem login, monta com o IP. A rota e o limite não entram na chave.
Por isso, todos os `throttle:N,1` sem 3º parâmetro gastam **um único contador**:
- Com login: cada toque em campo (30/min), justificativa (20/min), aviso de correção (30/min), pedido de planilha (10/min) e assistente (12/min) conta para todos os outros. Na prática, quem estoura um fica barrado nos outros também, com o limite mais baixo valendo.
- Sem login: cadastro (10/min), "esqueci a senha" (5/min), troca de senha (10/min) e convite (30/min) dividem o contador **por IP**. Num escritório ou numa rede móvel atrás de NAT, várias pessoas usam o mesmo IP.

**Correção:** um prefixo em cada rota, como `throttle:30,1,campo`, ou limitadores com nome em `AppServiceProvider`, como já existe para o `login`. As rotas da IA já saem com prefixo próprio.

## Testes

PHPUnit na pasta local (build 601): **767 de 768 passaram** (27.514 asserções, 10 min).
A única falha é `AssistenteAjudaTest::test_copia_da_ajuda_no_servidor_e_igual_a_do_app`. **Não é divergência real:** no git, as duas cópias da ajuda são idênticas (no 601 e no 603). Só no disco desta máquina o `svelte-ajuda/src/ajuda-conteudo.html` ficou com quebra de linha CRLF, e o teste compara o MD5 do arquivo cru.
**Correção:** normalizar `\r\n` antes do MD5 no teste, ou fixar `*.html text eol=lf` no `.gitattributes`.

## O que foi verificado e está OK

- **Permissões:** gestor/admin/contador/focal checados no servidor; `SomenteLeitura` fecha a escrita do Contador por padrão; `ExigeConfirmacao` tranca o cadastro pendente; desativar derruba os tokens; tokens parados são limpos (`tokens:limpar`).
- **Anexos:** caminho com regex estrita e sem `..`; `foto_path` nunca vem do cliente; URL assinada de 5 min; XML com `CSP: sandbox`; `nosniff`, HSTS e `Referrer-Policy` na API.
- **Backup:** nome do arquivo validado; só gestor/admin baixam; Drive com `state` assinado (HMAC + validade).
- **Busca geral:** usa o mesmo `visiveisPara` das listas; o LIKE escapa `%` e `_`.
- **Atividade em campo e lixeira:** dono e gestor/focal veem o que devem; apagar de vez só gestor/admin e só o que já está na lixeira; o antes vai para o log.
- **Front:** `esc()` e `_at()` aplicados nas interpolações com dado do usuário (varredura por nome, endereço, observação, motivo, resposta e campo); nenhum `prompt`/`confirm`/`alert` nativo; pdf.js com `isEvalSupported:false`; o service worker nunca guarda resposta da API.
- **Layout a 320 px**, com nome longo e valores de R$ 99.999,99: Início (RDM/RDA e C.V.), Home, Despesas e Saldo **sem estouro** (`scrollWidth = largura`).
- **CSS para iOS:** `dvh` com fallback, inputs com 16 px, `safe-area` no rodapé, modais com rolagem.

## Não coberto nesta rodada

- Teste em iPhone real (Safari não roda aqui).
- Produção por SSH: log de erros, disco e cron. O último levantamento foi em 06/11.
- Telas do gestor com dados reais (Equipe, Fechamento, Rastreio) no detector de estouro: só as telas do colaborador foram montadas.

## Correções feitas (branch `claude/auditoria-correcoes`, a partir da origin/main 603)

- **Item 2:** limite de 20 por minuto, com contador próprio, nas duas leituras por IA.
- **Item 5:** `POST /admin/migrar` só gera `banco-*.zip` se houver migração pendente, e gera **antes** de migrar. Se a cópia falhar, responde 500 e não migra. O nome do backup volta na resposta, e o app mostra no aviso e no texto de confirmação.
- **Item 6:** os 28 nomes entraram no `eslint.config.mjs` (`_fotoSeq` e `notas` como graváveis, `Fechamento` como `window.X`). `no-useless-assignment` e `no-useless-escape` viraram aviso. O resultado é **0 erros** (20 avisos), e o `publicar.sh` agora roda o ESLint antes de publicar o app (com erro, não publica).
- **Testes:** `AuditoriaCorrecoesTest`, com 5 testes. Cobre: sem pendência não gera backup; com pendência, o backup é do banco antes da migração; backup que falha não migra; colaborador não migra; 21º pedido em 1 minuto dá 429, e o contador da nota não trava o do KM.

## Ordem sugerida

1. Item 1, antes da próxima publicação.
2. Itens 2, 5 e 6: pequenos e de efeito imediato, cabem num build só.
3. Item 3, depois de você decidir o limite de horas.
4. Itens 4, 7 e 8–12, num build de manutenção.
5. Item 14, junto da próxima mexida no Início.

## Correções do build 607 (10/11/2026)

- **Item 1:** o `publicar.sh` confere o git antes de tudo. Recusa se houver arquivo modificado sem commit ou se a pasta estiver atrás de `origin/main`. Sem acesso ao GitHub, só avisa. `--sem-git` pula a conferência (emergência).
- **Item 4:** `/atividades-campo/equipe` busca só o último registro de cada pessoa (subconsulta com `MAX(inicio)`).
- **Item 7:** `symfony/routing` e `symfony/http-kernel` em 7.4.23. O `composer audit` não acha mais nada. Publicar a API com `--vendor`.
- **Item 8:** "Conta desativada" só aparece depois da senha certa. O e-mail do login passa por `trim()`.
- **Item 9:** o login Google recusa e-mail não verificado (`email_verified`).
- **Item 11:** `observacao` e `qr_url` são cortados em 2000 caracteres. Não há recusa, para não travar a fila.
- **Item 12:** o service worker só guarda a resposta da CDN se ela for ok ou opaca (script sem `crossorigin`, que é o caso normal).
- **Item 13:** a lixeira de campos conta os registros com uma consulta só.
- **Item 15:** cada `throttle` tem um prefixo próprio (cadastro, convite, esqueci-senha, troca-senha, assistente, planilha-pedido, campo, justificativa, aviso-correcao).
- **Teste da ajuda:** compara sem `\r`. O CRLF do Windows não reprova mais a suíte.
- **Testes:** `AuditoriaCorrecoes2Test`, com 6 testes.

Continuam abertos: o item 3 (depende do limite de horas), o 10 (CSP/SRI) e o 14 (layout a 320 px, que precisa de imagem antes de mexer).

## Correções do build 608 (11/11/2026)

- **Item 3:** o servidor aceita a hora do aparelho até **24 h para trás**, conforme decisão do Cleiton. Um início ou fim mais antigo é recusado com o aviso "Peça ao gestor ou ao focal para lançar a hora certa", e a fila do app mostra o motivo. A correção feita pelo gestor ou pelo focal continua sem esse limite. O JSON passou a trazer `registrado_depois_min`, que mostra o selo **📶 registrado depois** quando o início chegou ao servidor 15 min ou mais depois do toque. Ajuda atualizada.
- **Item 10:** jsQR, pdf.js (com o worker), Quagga, SheetJS e Tesseract agora carregam com `integrity` (sha384) e `crossorigin`. A tabela `SRI_CDN` fica em `js/app.js`. Testado no navegador: as 6 bibliotecas carregam, e um arquivo diferente do esperado é recusado.
  - Ficam de fora: os arquivos que o próprio Tesseract baixa (worker e core em wasm) e a CSP. A CSP esbarra nos `onclick` inline.
- **Item 14:** o valor do cartão do Início fica numa linha só, com fonte `clamp(14px,4.6vw,18px)` e `nowrap`, e o valor da pílula fica junto (`.ih-num`). Conferido a 320 px até R$ 1.599.999,94, sem estouro.
- Suíte: 789/789. ESLint com zero erro.
