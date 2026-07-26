# Migrar o app para a Locaweb

Objetivo: os arquivos do app passam a ser servidos pela Locaweb, no lugar do
GitHub Pages. **O endereço continua o mesmo** (`app.pmservicosagronomicos.com.br`)
e **o Supabase não muda** — notas, logins e fotos continuam exatamente onde estão.

Regra de ouro: **não desligue o GitHub Pages antes do fim.** Ele fica no ar como
rede de segurança; se algo der errado, é só voltar o DNS e o app volta na hora.

---

## Passo 1 — Ativar o HTTPS (obrigatório)

O app **não funciona sem HTTPS**. Sem ele a câmera não abre, o app não instala
no celular e o funcionamento offline para. Não é opcional.

No painel da Locaweb, na área do domínio `pmservicosagronomicos.com.br`, procure
**Certificado SSL** e ative o certificado gratuito (Let's Encrypt) para o
subdomínio. Pode levar alguns minutos para ficar pronto.

---

## Passo 2 — Testar num subdomínio antes de virar a chave

Não suba direto no endereço que a equipe usa. Crie um subdomínio de teste, por
exemplo `teste.pmservicosagronomicos.com.br`, e faça o Passo 3 nele primeiro.
Assim, se algo estiver errado, ninguém fica sem o app.

No painel: **Subdomínios → Criar**, nome `teste`. Ative o SSL nele também.

---

## Passo 3 — Enviar os arquivos

Use o arquivo **`petermann-locaweb.zip`**.

1. Abra o **Gerenciador de Arquivos** da Locaweb (ou um programa de FTP).
2. Entre na pasta do subdomínio (costuma ser `public_html/teste` ou parecido —
   é a pasta que o painel indica como raiz daquele subdomínio).
3. Envie o `.zip` e use a opção **Extrair / Descompactar** ali dentro.

A estrutura tem que ficar exatamente assim:

```
(raiz do subdomínio)
├── .htaccess          ← configuração do servidor
├── index.html         ← redireciona para a pasta do app
└── rda-rdm-app/
    ├── index.html     ← o app
    ├── sw.js
    ├── manifest.json
    ├── logo.jpg, icon-192.png, icon-512.png
    └── js/  (10 arquivos)
```

### ⚠️ Cuidado com o `.htaccess`

O nome dele começa com ponto, e **a maioria dos gerenciadores esconde arquivos
assim**. Se ele não aparecer na lista depois de extrair, procure a opção
**"Mostrar arquivos ocultos"** e confirme que ele está lá.

Sem esse arquivo o HTTPS não é forçado e o app não atualiza direito nos
celulares. É o arquivo mais importante do pacote.

---

## Passo 4 — Testar de verdade

Abra `https://teste.pmservicosagronomicos.com.br` no celular e confira, nesta ordem:

- [ ] Abriu com **cadeado** na barra de endereço (HTTPS funcionando)
- [ ] Na tela de login, o rodapé mostra **Versão v51**
- [ ] Consegue entrar com e-mail e senha
- [ ] O painel da Home carrega com os números
- [ ] Toque no **+** → **Escanear QR**: a câmera abre e pede permissão
- [ ] Lance uma nota de teste com foto e confirme que ela salva
- [ ] Menu do navegador → **Adicionar à tela inicial**: instala e abre como app

Se todos passarem, siga. Se algum falhar, me avise o que aconteceu antes de
continuar — não vire o DNS com problema pendente.

---

## Passo 5 — Apontar o endereço real para a Locaweb

Só agora. No painel de **DNS** do domínio:

1. **Remova** o registro atual do subdomínio `app`. Hoje ele é um **CNAME**
   apontando para `cleitonjussara-coder.github.io` (é o GitHub). Enquanto ele
   existir, a Locaweb não assume.
2. Crie o subdomínio `app` apontando para a hospedagem da Locaweb — normalmente
   o painel faz isso sozinho ao criar o subdomínio.
3. Ative o SSL para `app`.
4. Envie os mesmos arquivos do Passo 3 para a pasta do subdomínio `app`.

A mudança de DNS **pode levar de alguns minutos até algumas horas** para valer
em todos os lugares. Durante esse tempo, uns celulares ainda verão o GitHub e
outros já verão a Locaweb — como o conteúdo é o mesmo, ninguém percebe.

---

## Passo 6 — Confirmar e avisar a equipe

Abra `https://app.pmservicosagronomicos.com.br` e confira o **v51** no rodapé
do login. Peça para cada pessoa **fechar e abrir o app uma vez**.

Quem já tem o app instalado **não precisa reinstalar**: o endereço não mudou,
então o atalho na tela inicial continua valendo.

---

## Passo 7 — Só depois de uma semana estável

Com tudo funcionando por alguns dias, dá para desativar o GitHub Pages no
repositório. Não tem pressa e não faz diferença no custo — deixar ligado é a
sua rede de segurança.

---

## O que muda no dia a dia

**A publicação deixa de ser automática.** Hoje, uma alteração no código vai
para o ar sozinha. Depois da migração, cada alteração vira: eu preparo um `.zip`
novo → você envia pelo painel → confere o número da versão.

O número da versão no rodapé do login continua sendo a forma de saber se a
atualização chegou. Se ele não mudou, o envio não completou.

**O que NÃO muda:** o Supabase. Notas, repasses, logins, permissões e fotos
continuam lá, sem nenhuma alteração. Esta migração mexe só nos arquivos do app.
