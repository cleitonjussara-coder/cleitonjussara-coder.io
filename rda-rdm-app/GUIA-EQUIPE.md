# Guia de Uso — Petermann App (RDA/RDM)

App para lançar notas (RDA/RDM), repasses e fotos, com sincronização automática.
Funciona **offline** e envia tudo para o servidor quando há internet.

---

## 1. Instalar no celular (PWA)

O app não precisa de loja — é instalado direto pelo navegador.

**Android (Chrome):**
1. Abra o link do app no **Chrome**.
2. Toque no menu (⋮) → **Adicionar à tela inicial** / **Instalar app**.
3. O ícone "Petermann" aparece como um aplicativo normal.

**iPhone (Safari):**
1. Abra o link no **Safari**.
2. Toque em **Compartilhar** (quadrado com seta) → **Adicionar à Tela de Início**.

**Permissões:** ao usar QR Code, código de barras ou foto, o celular pede acesso à **câmera** — toque em **Permitir**.

---

## 2. Criar conta e entrar

1. Abra o app → tela **Entrar**.
2. Sem conta? Toque em **Cadastrar**, informe nome, e-mail e senha (mín. 6 caracteres).
3. Confirme o cadastro pelo **e-mail** recebido.
4. Volte e faça login.

> Todo novo usuário entra como **colaborador**, núcleo **Cristalina** (padrão). O gestor/admin ajusta depois.

No **Perfil**, cada um define seu **Nome** e **Núcleo** (Cristalina, Formosa, Paracatu, Uberlândia, Outro) e salva.

---

## 3. Papéis (quem vê o quê)

| Papel | O que enxerga |
|---|---|
| **Colaborador** | Apenas as **próprias** notas e saldos |
| **Gestor** | Todos do **seu núcleo** (aba **Equipe**) |
| **Admin** | **Todos** os núcleos; pode editar nome/núcleo/papel |

- O **primeiro admin** é definido uma vez no painel do servidor (Supabase).
- Depois, o **admin** promove os demais dentro do app: aba **Equipe** → ✏️ no colaborador → escolher **Papel** (colaborador/gestor/admin) e **Núcleo** → Salvar.

---

## 4. Lançar uma nota (botão +)

Toque no **+** central. Escolha como lançar:

| Opção | Para que serve |
|---|---|
| 📷 **QR Code** | Ler o QR da **NFC-e** (cupom do consumidor) |
| 📊 **Cód. Barras** | Ler a **chave da NF-e** no código de barras do **DANFE** |
| 🔍 **Foto OCR** | Fotografar o cupom — lê **valor, empresa e CNPJ** do texto |
| 🔑 **Chave NF-e/NFC-e** | Digitar/colar a chave de **44 dígitos** |
| ✏️ **Manual** | Digitar tudo na mão |
| 💸 **Repasse** | Registrar PIX/transferência recebida |

No formulário:
- **Tipo:** RDA ou RDM (RDM tem **categoria**: Abastecimento, Hospedagem, Outros).
- **Anexar foto:** ao anexar, o app **lê a foto sozinho** (QR + texto) e completa os campos vazios — valor, CNPJ, empresa, data.
- Confira os dados e toque em **Salvar**.

> **Importante sobre o valor:** a chave (QR/código de barras) **não contém o valor** — isso é padrão da nota fiscal. O valor vem da **foto** (OCR lê o "TOTAL") ou você digita.

**Consultar no SEFAZ:** notas com chave mostram o botão **🔗** (na lista e no formulário) que abre a nota no site oficial — NF-e no Portal Nacional, NFC-e no portal do estado.

---

## 5. Telas

- **Home:** resumo do mês (saldos RDM/RDA, nº de notas, pendentes), gráfico por categoria, evolução e últimos lançamentos.
- **Notas:** lista do mês, filtro por RDA/RDM, editar/excluir, ver foto, consultar.
- **Saldo:** saldo do mês, repasses, **exportar CSV** e **Excel anual**.
- **Equipe** (só gestor/admin): cards por núcleo com saldo de cada colaborador, navegação por mês e **exportar Excel** da equipe.
- **Perfil:** dados, Google Drive, exportações e sair.

Use as setas **‹ ›** para trocar de **mês**.

---

## 6. Envio das informações para o servidor

O app é **offline-first**: tudo é salvo **primeiro no celular** e enviado ao servidor depois — você pode lançar notas **sem internet**.

**Quando envia automaticamente:**
- Ao **salvar** uma nota/repasse;
- Quando o celular **volta a ter internet**;
- A cada **60 segundos**, em segundo plano.

**Como acompanhar (indicador no topo):**
- 🟢 **online** — conectado;
- 🟡 **sincronizando** — enviando/recebendo;
- 🔴 **offline** — sem internet (dados ficam guardados no celular);
- ⏳ na nota — ainda **não enviada** (envia sozinho quando voltar a internet).

**Fotos:** ficam no celular e são enviadas ao armazenamento do servidor; se o **Google Drive** estiver conectado, também vão para a pasta compartilhada na nuvem.

**Google Drive (opcional):** em **Perfil** → **Entrar com Google Drive**. Serve como backup na nuvem compartilhada; sincroniza notas, repasses e fotos automaticamente.

---

## 7. Dicas para a equipe

- **Sempre confira o valor** antes de salvar (especialmente em QR/código de barras).
- Para o app ler melhor a **foto**: boa luz, cupom reto e enquadrado inteiro (com o QR/código visível).
- Lançou **offline**? Sem problema — confirme depois que o ⏳ sumiu (já foi pro servidor).
- Cada um usa **sua própria conta**; o gestor acompanha tudo pela aba **Equipe**.
