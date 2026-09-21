# Guia de Uso — Petermann App

*Prestação de contas da equipe de campo: notas RDA/RDM, repasses e anexos.*
*Versão do guia: 20/09/2026 (app build 188).*

Endereço do app: **app.pmservicosagronomicos.com.br/rda-rdm-app**

---

## 1. Instalar no celular

O app não está na loja — instala direto pelo navegador e vira um ícone normal.

**Android (Chrome):** abra o endereço → menu (⋮) → **Adicionar à tela inicial** / **Instalar app**. Se a opção não estiver no menu, toque em **Compartilhar…** e arraste a fileira de ícones de baixo para a esquerda — ela costuma estar ali.

**iPhone (Safari):** abra o endereço no **Safari** (pelo Chrome não dá) → **Compartilhar** (quadrado com seta) → **Adicionar à Tela de Início**.

Ao usar a câmera pela primeira vez, toque em **Permitir**.

O app se atualiza sozinho. Se parecer desatualizado, feche por completo e abra de novo. O número da versão aparece embaixo do botão **Entrar**, na tela de login.

---

## 2. Entrar

- **E-mail e senha** ou botão **Google**.
- Sem conta? **Cadastrar** → nome, e-mail e senha (mín. 6 caracteres).
- Esqueceu a senha? **Esqueci minha senha** → o link chega por e-mail (confira o spam), vale 1 hora.
- Em **Perfil**, preencha o **nome completo** — ele dá nome à sua pasta de arquivos e ao cabeçalho da planilha. Ali também dá para colocar a **foto do perfil**.

---

## 3. Tela Início

Ao entrar, o app abre no **Início**. O botão grande **🧾 Despesas Corporativas Petermann** abre a tela de lançamentos:

| Botão | Para que serve |
|---|---|
| 📷 **Lançar nota pelo QR Code** | Cupom fiscal com QR (posto, mercado, restaurante). O caminho mais rápido: quase tudo entra sozinho. |
| 📝 **Nota sem QR** | Recibo, DANFE em papel, nota de serviço, PDF ou XML. |
| 💸 **Repasse** | Dinheiro que você recebeu, ou que precisa pedir (PIX). |

Embaixo ficam o **resumo do mês**, as **pendências**, os últimos lançamentos e os atalhos **Ir para** (Painel, Minhas notas, Saldo, Perfil…).

Para voltar ao Início de qualquer tela: botão **🏠 Início** fixo na parte de baixo, ou toque na **logomarca** no topo.

---

## 4. Lançar pelo QR Code (passo a passo)

1. **Despesas Corporativas Petermann → Lançar nota pelo QR Code**. Aponte a câmera para o QR do cupom. Leu? O app avisa. (Não leu? **⌨️ Não leu? Digitar a chave** — os 44 dígitos.)
2. O app sugere a aba **RDA** ou **RDM** pelo fornecedor (posto → RDM · Abastecimento; restaurante → RDA). Toque em **Trocar** se não for isso.
3. **Tirar foto** do cupom inteiro (ou **Anexar arquivo**). **O anexo é obrigatório** — sem ele a nota não salva.
4. Enquadre o cupom no recorte e confirme. O app lê a foto e, em paralelo, busca o **valor oficial no site da SEFAZ**.
5. A nota aparece preenchida: empresa, CNPJ, data, valor, número, série e tipo. **Confira o valor** e toque em **Salvar**.

🌐 Quando aparece **"Valor conferido no SEFAZ"**, o valor veio do site oficial — pode confiar. Sem essa marca, o valor veio da leitura da foto: confira. (BA e GO conferem sozinhos; MG, SC e TO não permitem — nesses o valor vem sempre da foto.)

---

## 5. Lançar sem QR (recibo, DANFE, NFS-e)

1. **Nota sem QR** → escolha **RDA** ou **RDM**.
2. **Tirar foto** ou **Anexar arquivo** (imagem, PDF ou XML). Com XML preenche tudo.
3. O app lê o que der da foto (valor, data, CNPJ, número). Confira e **Salvar**.

Se o fornecedor já é conhecido, aparece uma **sugestão de aba/categoria** no topo — toque em **Aplicar** se concordar.

**Campos da nota:** *Tipo* (RDA ou RDM — RDM tem categoria: Abastecimento, Hospedagem, Outros; é ela que define a aba da planilha e a pasta dos arquivos) · *Documento* (NFC-e, NF-e, DANFE, NFS-e, Outro) · *Número e série* · *Valor* e *data* — sempre confira.

---

## 6. Notas repetidas e Lixeira

- O app **avisa** quando parece que a nota já foi lançada (mesma chave, mesmo número no mesmo fornecedor, ou mesmo fornecedor no mesmo dia com o mesmo valor). **Nada é apagado sozinho** — você decide.
- Apagar uma nota pede que você digite **EXCLUIR**; ela vai para a **Lixeira** (Minhas notas → 🗑 Apagados), de onde dá para **Restaurar** ou **Apagar definitivo**.
- Na lixeira, "⚠️ Já existe uma nota igual ativa" avisa que restaurar vai duplicar; "📱 Só neste aparelho" é uma cópia antiga que já não existe no servidor — use **Limpar daqui**.

---

## 7. Repasses e Saldo

- **Repasse → Registrar recebido**: dinheiro que entrou (PIX/transferência). **Solicitar repasse**: o pedido vai por e-mail para a empresa e fica como *pendente* até ser registrado como recebido.
- **Saldo**: RDM e RDA do mês (gasto, recebido, saldo), lista de repasses, **CSV** do mês e **Excel Anual**.
- **Planilha de C.V.** (Excel ou PDF): a planilha do ano no **modelo padrão da empresa**, preenchida pelo servidor com as notas e repasses lançados.

Use as setas **‹ ›** para trocar de mês. Ao ir para outro ano, o app baixa as notas daquele ano na hora (precisa de internet na primeira vez).

---

## 8. Sem internet

Tudo é salvo **primeiro no celular** e enviado depois. Dá para lançar no campo sem sinal; o envio acontece ao salvar, quando a internet volta, e a cada 60 segundos.

Indicador no topo: 🟢 **online** · 🟡 **sincronizando** · 🔴 **offline** (guardado no celular). **⏳** na nota = ainda não enviada — vai sozinha. Lançou offline? Confirme depois que o ⏳ sumiu.

As fotos ficam no **servidor da empresa** (não no Google Drive). Fotos entram já reduzidas (~400 KB), e o cupom continua legível.

---

## 9. Para gestor e admin

- **Equipe**: resumo do mês, evolução do ano e um cartão por colaborador (🔍 busca por nome/e-mail). Tocar no cartão abre o **detalhe**: foto, atalhos (Planilha CV Excel/PDF, Arquivos, Editar), gasto/recebido/saldo/pendências, RDM por categoria, gasto no ano, e as notas e repasses do mês.
- **📗 Excel** e **📕 PDF** no topo da Equipe: exportação e **Relatório da Equipe** do mês.
- **Arquivos** (Início → 📁): as notas de cada colaborador por mês, em miniatura, e o **ZIP** do mês ou do ano já nas pastas do modelo da empresa, com a Planilha CV dentro.
- **✏️ no cartão**: papel/núcleo (admin), **Desativar** quem saiu (não entra mais; histórico fica) ou **Excluir de vez** (apaga tudo; exige duas pessoas — um gestor/admin pede, outro confirma).
- **Admin — Perfil → Backup**: backup automático todo domingo (banco + fotos), download pelo app; erros do servidor chegam por e-mail.
- Em **Minhas notas**, Painel, Saldo e Início o gestor/admin vê **só as próprias**; a equipe é vista na aba **Equipe**.

---

## 10. Dicas

- Cupom com **QR**? Use o QR — é mais rápido e o valor pode vir do SEFAZ.
- Foto boa: luz, cupom reto e inteiro no recorte.
- **Confira o valor** antes de salvar quando não houver a marca do SEFAZ.
- Cada um usa **sua própria conta**; nunca lance pela conta de outro.
- Dúvida? **Perfil → ❓ Como usar o app** tem tudo isto, sempre atualizado.
